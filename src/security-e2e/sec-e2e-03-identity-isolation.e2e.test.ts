/**
 * SEC-E2E-03 — Cloud identity isolation.
 *
 * Claim: a GitHub Actions run for tenant A can sign in to tenant A's cloud
 * and fetch tenant A's secrets, and cannot do either for tenant B.
 *
 * Three trust decisions, each made by a different party:
 *   - AWS STS, matching the token against the customer's deployment role
 *     (and the platform against the onboarding role's ExternalId);
 *   - Entra ID, matching it against the customer's federated credential;
 *   - the platform itself, releasing an Azure tenant's secrets.
 *
 * The first two are simulated from the bootstrap templates the customer
 * deploys (scripts/lib/security-model.cjs). The third runs for real: the
 * secrets endpoint's logic, a migrated Postgres (PGlite), AES-GCM ciphertexts,
 * and RS256 tokens signed by a local key that stands in for GitHub's.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, type JWTVerifyGetKey } from "jose";
import model from "../../scripts/lib/security-model.cjs";
import { evidence, fixtureSecret, outcome } from "@/test/evidence";

const h = vi.hoisted(() => ({ client: null as null | import("@electric-sql/pglite").PGlite }));

vi.mock("@/db", async () => {
  const { migratedDatabase } = await import("@/test/pglite-db");
  const { client, db } = await migratedDatabase();
  h.client = client;
  return { db };
});
vi.mock("@/lib/github", () => ({
  getChatbotRepo: () => ({ owner: "acme", repo: "platform" }),
  getDeployWorkflowId: () => "deploy-tenant.yml",
  getDestroyWorkflowId: () => "destroy-tenant.yml",
}));

import { db } from "@/db";
import { deployments, tenants, users } from "@/db/schema";
import { encryptSecret } from "@/lib/crypto";
import { releaseDeploymentSecrets } from "@/lib/deploymentSecrets";
import { awsTrustPolicy, awsOnboardingTrustPolicy } from "@/lib/awsTrust";
import { azureFederatedSubject } from "@/lib/azureFederation";
import { GITHUB_OIDC_ISSUER, PLATFORM_SECRETS_AUDIENCE, tenantDeploySubject } from "@/lib/githubOidc";

const record = evidence("SEC-E2E-03");

const REPO = { owner: "acme", repo: "platform" };
const TENANT_A = "a0000000-0000-4000-8000-00000000000a";
const TENANT_B = "b0000000-0000-4000-8000-00000000000b";
const CUSTOMER = "111111111111";
const PLATFORM = "222222222222";
const subjectOf = (tenantId: string) => tenantDeploySubject(REPO, tenantId);

const allowed = (d: { decision: string }) => d.decision === "Allow";

// ── AWS: the deployment role trusts one GitHub environment ────────────────
describe("SEC-E2E-03 · AWS STS: tenant A's role refuses tenant B's run", () => {
  const providerA = `arn:aws:iam::${CUSTOMER}:oidc-provider/token.actions.githubusercontent.com`;
  const policies = {
    "bootstrap template": model.roleStatements(
      model.renderAwsBootstrap(model.sampleTenant({ tenantId: TENANT_A, slug: "alpha", ...REPO, customerAccount: CUSTOMER, platformAccount: PLATFORM })),
      "DeploymentRole",
    ).trust,
    "policy the wizard shows": JSON.parse(awsTrustPolicy({ customerAccountId: CUSTOMER, githubRepo: REPO, tenantId: TENANT_A })).Statement,
  };
  const exchange = (trust: unknown[], token: { sub: string; aud?: string; provider?: string }) =>
    model.evaluate(trust, {
      action: "sts:AssumeRoleWithWebIdentity",
      caller: { Federated: token.provider ?? providerA },
      context: {
        "token.actions.githubusercontent.com:sub": token.sub,
        "token.actions.githubusercontent.com:aud": token.aud ?? "sts.amazonaws.com",
      },
    });

  describe.each(Object.entries(policies))("%s", (source, trust) => {
    it("control: tenant A's own run signs in", () => {
      const d = exchange(trust, { sub: subjectOf(TENANT_A) });
      record.control(`AWS (${source}): A's run assumes A's deployment role`, {
        expected: "Allow",
        actual: d,
        allowed: allowed(d),
      });
      expect(allowed(d)).toBe(true);
    });

    it.each([
      ["tenant B's environment", { sub: subjectOf(TENANT_B) }],
      ["the deploy branch, no environment", { sub: `repo:acme/platform:ref:refs/heads/main` }],
      ["a pull request", { sub: "repo:acme/platform:pull_request" }],
      ["a fork naming A's environment", { sub: `repo:mallory/platform:environment:tenant-${TENANT_A}` }],
      ["a prefix of A's environment", { sub: subjectOf(TENANT_A).slice(0, -4) }],
      ["A's environment upper-cased", { sub: subjectOf(TENANT_A).toUpperCase() }],
      ["Azure's audience", { sub: subjectOf(TENANT_A), aud: "api://AzureADTokenExchange" }],
      ["the platform's own audience", { sub: subjectOf(TENANT_A), aud: PLATFORM_SECRETS_AUDIENCE }],
      ["another identity provider (issuer)", { sub: subjectOf(TENANT_A), provider: `arn:aws:iam::${CUSTOMER}:oidc-provider/attacker.example` }],
    ])("refuses a token from %s", (label, token) => {
      const d = exchange(trust, token);
      record.attack(`AWS (${source}): token from ${label}`, {
        expected: "refused",
        actual: { sub: token.sub, aud: "aud" in token ? token.aud : "sts.amazonaws.com", decision: d.decision },
        refused: !allowed(d),
      });
      expect(allowed(d)).toBe(false);
    });

    it("refuses the platform's AWS account outright", () => {
      const d = model.evaluate(trust, { action: "sts:AssumeRole", caller: { AWS: `arn:aws:iam::${PLATFORM}:role/platform-control-plane` } });
      record.attack(`AWS (${source}): the platform assumes the deployment role`, {
        expected: "refused — this role trusts GitHub only",
        actual: d,
        refused: !allowed(d),
      });
      expect(allowed(d)).toBe(false);
    });
  });
});

// ── AWS: the onboarding role trusts the platform for one ExternalId ───────
describe("SEC-E2E-03 · AWS STS: the onboarding role's ExternalId", () => {
  const platformRole = `arn:aws:iam::${PLATFORM}:role/platform-control-plane`;
  const policies = {
    "bootstrap template": model.roleStatements(
      model.renderAwsBootstrap(model.sampleTenant({ tenantId: TENANT_A, slug: "alpha", ...REPO, customerAccount: CUSTOMER, platformAccount: PLATFORM })),
      "OnboardingRole",
    ).trust,
    "policy the wizard shows": JSON.parse(awsOnboardingTrustPolicy({ platformAccountId: PLATFORM, tenantId: TENANT_A })).Statement,
  };
  const assume = (trust: unknown[], caller: string, externalId?: string) =>
    model.evaluate(trust, {
      action: "sts:AssumeRole",
      caller: { AWS: caller },
      context: externalId === undefined ? {} : { "sts:ExternalId": externalId },
    });

  describe.each(Object.entries(policies))("%s", (source, trust) => {
    it("control: the platform with A's ExternalId", () => {
      const d = assume(trust, platformRole, TENANT_A);
      record.control(`AWS onboarding (${source}): platform with A's ExternalId`, { expected: "Allow", actual: d, allowed: allowed(d) });
      expect(allowed(d)).toBe(true);
    });

    it.each([
      ["tenant B's ExternalId", platformRole, TENANT_B],
      ["no ExternalId", platformRole, undefined],
      ["A's ExternalId upper-cased", platformRole, TENANT_A.toUpperCase()],
      ["A's ExternalId with a suffix", platformRole, `${TENANT_A}x`],
      ["A's ExternalId, from another AWS account", "arn:aws:iam::333333333333:role/someone", TENANT_A],
    ])("refuses %s", (label, caller, externalId) => {
      const d = assume(trust, caller, externalId);
      record.attack(`AWS onboarding (${source}): ${label}`, { expected: "refused", actual: d, refused: !allowed(d) });
      expect(allowed(d)).toBe(false);
    });
  });
});

// ── Azure: the federated credential names one environment ─────────────────
describe("SEC-E2E-03 · Entra ID: tenant A's credential refuses tenant B's run", () => {
  const credential = model.azureFederatedCredential({ ...REPO, tenantId: TENANT_A });
  const token = (overrides: Partial<{ iss: string; sub: string; aud: string }>) => ({
    iss: GITHUB_OIDC_ISSUER,
    sub: subjectOf(TENANT_A),
    aud: "api://AzureADTokenExchange",
    ...overrides,
  });

  it("control: the template's credential is the one the platform tells the customer to create, and admits A's run", () => {
    const accepted = model.entraAccepts(credential, token({}));
    record.control("Azure: A's run exchanges its token with A's federated credential", {
      expected: "accepted; template subject equals azureFederatedSubject()",
      actual: { subject: credential.subject, matchesApp: credential.subject === azureFederatedSubject(REPO, TENANT_A), wiredThrough: credential.wiredThrough, accepted },
      allowed: accepted && credential.wiredThrough && credential.subject === azureFederatedSubject(REPO, TENANT_A),
    });
    expect(credential.wiredThrough).toBe(true);
    expect(credential.subject).toBe(azureFederatedSubject(REPO, TENANT_A));
    expect(accepted).toBe(true);
  });

  it.each([
    ["tenant B's environment", { sub: subjectOf(TENANT_B) }],
    ["the deploy branch", { sub: "repo:acme/platform:ref:refs/heads/main" }],
    ["a fork naming A's environment", { sub: `repo:mallory/platform:environment:tenant-${TENANT_A}` }],
    ["AWS's audience", { aud: "sts.amazonaws.com" }],
    ["the platform's own audience", { aud: PLATFORM_SECRETS_AUDIENCE }],
    ["a lookalike issuer", { iss: `${GITHUB_OIDC_ISSUER}.attacker.example` }],
    ["an issuer with a trailing slash", { iss: `${GITHUB_OIDC_ISSUER}/` }],
  ])("refuses a token from %s", (label, overrides) => {
    const presented = token(overrides);
    const accepted = model.entraAccepts(credential, presented);
    record.attack(`Azure: token from ${label}`, { expected: "refused", actual: { ...presented, accepted }, refused: !accepted });
    expect(accepted).toBe(false);
  });
});

// ── The platform: releasing an Azure tenant's secrets ────────────────────
describe("SEC-E2E-03 · the platform releases a tenant's secrets to that tenant's run only", () => {
  const ENCRYPTION_KEY = fixtureSecret("3c".repeat(32));
  const LLM_A = fixtureSecret("sk-e2e-alpha-llm-key-0f9e8d7c6b5a49382716");
  const LLM_B = fixtureSecret("sk-e2e-beta-llm-key-1a2b3c4d5e6f70819203");
  const PINECONE_A = fixtureSecret("pcsk_e2e_alpha_pinecone_key_000000000000");
  const SIGNER_A = fixtureSecret("e2e-alpha-docs-signer-secret-7b6a5c4d");
  const DEPLOY_REF = "acme/platform/.github/workflows/deploy-tenant-azure.yml@refs/heads/main";

  let keys: JWTVerifyGetKey;
  let signingKey: CryptoKey;
  let deploymentA: string;
  let deploymentB: string;

  beforeAll(async () => {
    process.env.PLATFORM_ENCRYPTION_KEY = ENCRYPTION_KEY;
    const pair = await generateKeyPair("RS256", { extractable: true });
    signingKey = pair.privateKey;
    keys = createLocalJWKSet({ keys: [{ ...(await exportJWK(pair.publicKey)), kid: "gh", alg: "RS256" }] });
  });

  beforeEach(async () => {
    delete process.env.CHATBOT_DEPLOY_REF;
    await h.client!.exec("TRUNCATE users, tenants, deployments RESTART IDENTITY CASCADE");
    await db.insert(users).values([{ id: "user-alice" }, { id: "user-bob" }]);
    const azure = (id: string, owner: string, slug: string, llm: string) => ({
      id,
      name: slug,
      slug,
      ownerUserId: owner,
      cloudProvider: "azure" as const,
      azureSubscriptionId: "11111111-1111-4111-8111-111111111111",
      azureTenantId: "22222222-2222-4222-8222-222222222222",
      azureClientId: "33333333-3333-4333-8333-333333333333",
      azureRegion: "swedencentral",
      llmProvider: "openai" as const,
      llmApiKeyEncrypted: encryptSecret(llm),
      vectorStore: "pinecone" as const,
      pineconeApiKeyEncrypted: encryptSecret(PINECONE_A),
      docsSignerSecretEncrypted: encryptSecret(SIGNER_A),
    });
    await db.insert(tenants).values([azure(TENANT_A, "user-alice", "alpha", LLM_A), azure(TENANT_B, "user-bob", "beta", LLM_B)]);
    const rows = await db
      .insert(deployments)
      .values([
        { tenantId: TENANT_A, triggeredByUserId: "user-alice", chatbotVersion: "latest", status: "running" as const },
        { tenantId: TENANT_B, triggeredByUserId: "user-bob", chatbotVersion: "latest", status: "running" as const },
      ])
      .returning({ id: deployments.id, tenantId: deployments.tenantId });
    deploymentA = rows.find((r) => r.tenantId === TENANT_A)!.id;
    deploymentB = rows.find((r) => r.tenantId === TENANT_B)!.id;
  });

  const runToken = (claims: Partial<{ sub: string; repository: string; workflow_ref: string; run_id: string }> = {}) =>
    new SignJWT({ sub: subjectOf(TENANT_A), repository: "acme/platform", workflow_ref: DEPLOY_REF, run_id: "1001", ...claims })
      .setProtectedHeader({ alg: "RS256", kid: "gh" })
      .setIssuer(GITHUB_OIDC_ISSUER)
      .setAudience(PLATFORM_SECRETS_AUDIENCE)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(signingKey);

  const ask = async (deploymentId: string, jwt: string) => {
    const result = await outcome(() => releaseDeploymentSecrets(deploymentId, jwt, keys));
    // Evidence names what came back, never the values.
    return result.ok
      ? { ok: true as const, released: Object.keys(result.value).sort(), values: result.value as Record<string, string> }
      : { ok: false as const, error: result.error };
  };
  const claimed = async (id: string) =>
    (await h.client!.query<{ secrets_claimed_at: string | null; github_run_id: string | null }>(
      "SELECT secrets_claimed_at, github_run_id FROM deployments WHERE id = $1",
      [id],
    )).rows[0];

  it("control: A's deploy run receives A's secrets, once", async () => {
    const res = await ask(deploymentA, await runToken());
    const row = await claimed(deploymentA);
    const correct = res.ok && res.values.llmApiKey === LLM_A && res.values.docsSignerSecret === SIGNER_A;
    record.control("A's deploy run asks for A's deployment secrets", {
      expected: "released (decrypted correctly), claim recorded with the run ID",
      actual: { released: res.ok ? res.released : res.error, decryptedCorrectly: correct, claimed: row.secrets_claimed_at !== null, runId: row.github_run_id },
      allowed: correct && row.secrets_claimed_at !== null,
    });
    expect(correct).toBe(true);
    expect(row.github_run_id).toBe("1001");
  });

  it.each([
    ["B's run, for A's deployment", () => deploymentA, { sub: subjectOf(TENANT_B) }],
    ["A's run, for B's deployment", () => deploymentB, {}],
    ["the connection check in A's environment", () => deploymentA, { workflow_ref: "acme/platform/.github/workflows/verify-tenant-azure.yml@refs/heads/main" }],
    ["A's workflow from a feature branch", () => deploymentA, { workflow_ref: DEPLOY_REF.replace("main", "feature") }],
    ["a fork's run naming A's environment", () => deploymentA, { repository: "mallory/platform" }],
  ])("refuses %s, and leaves the deployment unclaimed", async (label, target, claims) => {
    const id = target();
    const res = await ask(id, await runToken(claims));
    const row = await claimed(id);
    record.attack(`Secrets: ${label}`, {
      expected: "refused; secrets_claimed_at still null",
      actual: { result: res.ok ? { released: res.released } : res, claimed: row.secrets_claimed_at !== null },
      refused: !res.ok && row.secrets_claimed_at === null,
    });
    expect(res.ok).toBe(false);
    expect(row.secrets_claimed_at).toBeNull();
  });

  it("refuses a second run after the first has claimed, and a replay by the first", async () => {
    await ask(deploymentA, await runToken());
    const other = await ask(deploymentA, await runToken({ run_id: "2002" }));
    const replay = await ask(deploymentA, await runToken());
    record.attack("Secrets: a second run, then the first run again, after the claim", {
      expected: "both refused with 409",
      actual: { other: other.ok ? "released" : other.error, replay: replay.ok ? "released" : replay.error },
      refused: !other.ok && !replay.ok,
    });
    expect(other.ok || replay.ok).toBe(false);
  });

  it("two runs racing for one deployment: exactly one is served", async () => {
    const [first, second] = await Promise.all([
      (async () => ask(deploymentA, await runToken({ run_id: "3003" })))(),
      (async () => ask(deploymentA, await runToken({ run_id: "3004" })))(),
    ]);
    const row = await claimed(deploymentA);
    const served = [first, second].filter((r) => r.ok).length;
    record.attack("Secrets: two runs claim one deployment at once", {
      expected: "one served, one refused; the row names the winner's run",
      actual: { served, runId: row.github_run_id },
      refused: served === 1 && ["3003", "3004"].includes(row.github_run_id ?? ""),
    });
    expect(served).toBe(1);
  });

  // The claim is one conditional UPDATE; each condition is tested by a case
  // that only it can refuse (the generated mutants found these three untested).
  it("A's claim marks only A's deployment: B's run is still served afterwards", async () => {
    await ask(deploymentA, await runToken());
    const b = await claimed(deploymentB);
    const res = await ask(deploymentB, await runToken({ sub: subjectOf(TENANT_B), run_id: "7007" }));
    record.attack("Secrets: A's claim spilling onto B's running deployment", {
      expected: "B's deployment still unclaimed and tied to no run after A's claim; B's run then served",
      actual: { bClaimed: b.secrets_claimed_at !== null, bRun: b.github_run_id, bServed: res.ok },
      refused: b.secrets_claimed_at === null && b.github_run_id === null && res.ok,
    });
    expect(b.secrets_claimed_at).toBeNull();
    expect(b.github_run_id).toBeNull();
    expect(res.ok).toBe(true);
  });

  it("releases nothing for a deployment that finished without releasing its secrets", async () => {
    await h.client!.query("UPDATE deployments SET status = 'failed', finished_at = now() WHERE id = $1", [deploymentA]);
    const res = await ask(deploymentA, await runToken());
    const row = await claimed(deploymentA);
    record.attack("Secrets: A's own run, for A's deployment after it failed", {
      expected: "refused; still unclaimed",
      actual: { result: res.ok ? "released" : res.error, claimed: row.secrets_claimed_at !== null },
      refused: !res.ok && row.secrets_claimed_at === null,
    });
    expect(res.ok).toBe(false);
    expect(row.secrets_claimed_at).toBeNull();
  });

  it("serves only the run the run-started callback recorded", async () => {
    await h.client!.query("UPDATE deployments SET github_run_id = '5005' WHERE id = $1", [deploymentA]);
    const other = await ask(deploymentA, await runToken({ run_id: "6006" }));
    const unclaimed = await claimed(deploymentA);
    const own = await ask(deploymentA, await runToken({ run_id: "5005" }));
    record.attack("Secrets: another run of A's workflow, for a deployment already tied to run 5005", {
      expected: "refused; still unclaimed",
      actual: { result: other.ok ? "released" : other.error, claimed: unclaimed.secrets_claimed_at !== null },
      refused: !other.ok && unclaimed.secrets_claimed_at === null,
    });
    record.control("Secrets: run 5005, the one recorded", {
      expected: "served",
      actual: { served: own.ok },
      allowed: own.ok,
    });
    expect(other.ok).toBe(false);
    expect(unclaimed.secrets_claimed_at).toBeNull();
    expect(own.ok).toBe(true);
  });

  it("control: B's run still receives B's own secrets", async () => {
    const res = await ask(deploymentB, await runToken({ sub: subjectOf(TENANT_B), run_id: "4004" }));
    const correct = res.ok && res.values.llmApiKey === LLM_B;
    record.control("B's deploy run asks for B's deployment secrets", {
      expected: "released, decrypted to B's key and not A's",
      actual: { released: res.ok ? res.released : res.error, decryptedCorrectly: correct },
      allowed: correct,
    });
    expect(correct).toBe(true);
  });
});
