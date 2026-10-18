import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { SignJWT, createLocalJWKSet, exportJWK, exportSPKI, generateKeyPair, type JWTVerifyGetKey } from "jose";
import { selectJoinChain, updateSetWhereChain } from "@/test/db-chains";

const { dbSelectWhere, dbUpdateReturning, decryptSecret, getChatbotRepo } = vi.hoisted(() => ({
  dbSelectWhere: vi.fn(),
  dbUpdateReturning: vi.fn(),
  decryptSecret: vi.fn((blob: string) => `decrypted:${blob}`),
  getChatbotRepo: vi.fn(),
}));

vi.mock("@/db", () => ({
  db: {
    select: vi.fn(() => selectJoinChain(dbSelectWhere)),
    update: vi.fn(() => updateSetWhereChain(vi.fn(() => ({ returning: dbUpdateReturning })))),
  },
}));
vi.mock("@/lib/crypto", () => ({ decryptSecret }));
vi.mock("@/lib/github", () => ({ getChatbotRepo }));

import { db } from "@/db";
import { releaseDeploymentSecrets, SecretsRequestError } from "./deploymentSecrets";
import { GITHUB_OIDC_ISSUER, PLATFORM_SECRETS_AUDIENCE } from "./githubOidc";

const TENANT_ID = "7f1c2a9e-0000-4000-8000-000000000001";
const DEPLOYMENT_ID = "dep-1";
const REPO = "acme/platform";
const SUBJECT = `repo:${REPO}:environment:tenant-${TENANT_ID}`;
const DEPLOY_WORKFLOW_REF = `${REPO}/.github/workflows/deploy-tenant-azure.yml@refs/heads/main`;
const DESTROY_WORKFLOW_REF = `${REPO}/.github/workflows/destroy-tenant-azure.yml@refs/heads/main`;

const azureTenant = {
  id: TENANT_ID,
  cloudProvider: "azure",
  llmApiKeyEncrypted: "iv:tag:llm",
  pineconeApiKeyEncrypted: "iv:tag:pc",
  docsSignerSecretEncrypted: "iv:tag:ds",
};
const deployDeployment = { id: DEPLOYMENT_ID, tenantId: TENANT_ID, kind: "deploy", status: "running" };

let keys: JWTVerifyGetKey;
let signingKey: CryptoKey;
let foreignKey: CryptoKey;
let publicPem: string;

beforeAll(async () => {
  const pair = await generateKeyPair("RS256", { extractable: true });
  signingKey = pair.privateKey;
  publicPem = await exportSPKI(pair.publicKey);
  keys = createLocalJWKSet({ keys: [{ ...(await exportJWK(pair.publicKey)), kid: "gh", alg: "RS256" }] });
  foreignKey = (await generateKeyPair("RS256")).privateKey;
});

type Claims = Record<string, unknown>;

function token(overrides: Claims = {}, opts: { key?: CryptoKey; audience?: string; issuer?: string } = {}) {
  const claims: Claims = {
    sub: SUBJECT,
    repository: REPO,
    workflow_ref: DEPLOY_WORKFLOW_REF,
    run_id: "4242",
    ...overrides,
  };
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: "gh" })
    .setIssuer(opts.issuer ?? GITHUB_OIDC_ISSUER)
    .setAudience(opts.audience ?? PLATFORM_SECRETS_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(opts.key ?? signingKey);
}

async function release(jwt: string) {
  return releaseDeploymentSecrets(DEPLOYMENT_ID, jwt, keys);
}

async function refusal(jwt: string): Promise<SecretsRequestError> {
  const err = await release(jwt).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(SecretsRequestError);
  return err as SecretsRequestError;
}

describe("releaseDeploymentSecrets", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.CHATBOT_DEPLOY_REF;
    getChatbotRepo.mockReturnValue({ owner: "acme", repo: "platform" });
    dbSelectWhere.mockResolvedValue([{ deployment: deployDeployment, tenant: azureTenant }]);
    dbUpdateReturning.mockResolvedValue([{ id: DEPLOYMENT_ID }]);
    decryptSecret.mockImplementation((blob: string) => `decrypted:${blob}`);
  });

  it("releases the three deploy secrets to this tenant's deploy run", async () => {
    await expect(release(await token())).resolves.toEqual({
      llmApiKey: "decrypted:iv:tag:llm",
      pineconeApiKey: "decrypted:iv:tag:pc",
      docsSignerSecret: "decrypted:iv:tag:ds",
    });
  });

  it("gives a teardown run only the Pinecone key", async () => {
    dbSelectWhere.mockResolvedValue([
      { deployment: { ...deployDeployment, kind: "destroy" }, tenant: azureTenant },
    ]);

    await expect(release(await token({ workflow_ref: DESTROY_WORKFLOW_REF }))).resolves.toEqual({
      pineconeApiKey: "decrypted:iv:tag:pc",
    });
  });

  it("returns an empty Pinecone key for a pgvector tenant", async () => {
    dbSelectWhere.mockResolvedValue([
      { deployment: deployDeployment, tenant: { ...azureTenant, pineconeApiKeyEncrypted: null } },
    ]);

    await expect(release(await token())).resolves.toMatchObject({ pineconeApiKey: "" });
  });

  describe("the token", () => {
    it("must be signed by GitHub", async () => {
      expect((await refusal(await token({}, { key: foreignKey }))).status).toBe(401);
    });

    // The two classic JWT forgeries. Both carry claims a real run's token
    // would, so only the algorithm check can refuse them.
    it("is refused unsigned (alg: none)", async () => {
      const [, claims] = (await token()).split(".");
      const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");

      expect((await refusal(`${header}.${claims}.`)).status).toBe(401);
      expect(decryptSecret).not.toHaveBeenCalled();
    });

    it("is refused when HMAC-signed with GitHub's public key (algorithm confusion)", async () => {
      const forged = await new SignJWT({ sub: SUBJECT, repository: REPO, workflow_ref: DEPLOY_WORKFLOW_REF, run_id: "4242" })
        .setProtectedHeader({ alg: "HS256", kid: "gh" })
        .setIssuer(GITHUB_OIDC_ISSUER)
        .setAudience(PLATFORM_SECRETS_AUDIENCE)
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(new TextEncoder().encode(publicPem));

      expect((await refusal(forged)).status).toBe(401);
      expect(decryptSecret).not.toHaveBeenCalled();
    });

    // A token minted to sign in to Azure or AWS must not work here, and the
    // other way round.
    it.each(["api://AzureADTokenExchange", "sts.amazonaws.com"])(
      "is refused when minted for the audience %s",
      async (audience) => {
        expect((await refusal(await token({}, { audience }))).status).toBe(401);
      },
    );

    it("must come from GitHub's issuer", async () => {
      expect((await refusal(await token({}, { issuer: "https://evil.example" }))).status).toBe(401);
    });

    it("must carry the claims that identify a run", async () => {
      expect((await refusal(await token({ workflow_ref: undefined }))).status).toBe(401);
    });

    it("is not a JWT at all", async () => {
      expect((await refusal("not-a-token")).status).toBe(401);
    });
  });

  // Attack matrix — GitHub OIDC. Near misses of each claim the platform
  // checks: each would pass a comparison that was a prefix, case-insensitive
  // or pattern match, and none may pass an exact one.
  describe("a near-miss token", () => {
    async function signed(build: (jwt: SignJWT) => SignJWT) {
      const jwt = new SignJWT({ sub: SUBJECT, repository: REPO, workflow_ref: DEPLOY_WORKFLOW_REF, run_id: "4242" })
        .setProtectedHeader({ alg: "RS256", kid: "gh" })
        .setIssuer(GITHUB_OIDC_ISSUER)
        .setAudience(PLATFORM_SECRETS_AUDIENCE)
        .setIssuedAt();
      return build(jwt).sign(signingKey);
    }

    it("is refused once expired", async () => {
      const expired = await signed((jwt) => jwt.setIssuedAt(Math.floor(Date.now() / 1000) - 600).setExpirationTime("-5m"));
      expect((await refusal(expired)).status).toBe(401);
    });

    it("is refused before it becomes valid", async () => {
      const early = await signed((jwt) => jwt.setNotBefore("10m").setExpirationTime("20m"));
      expect((await refusal(early)).status).toBe(401);
    });

    it.each([
      ["a lookalike host", "https://token.actions.githubusercontent.com.attacker.example"],
      ["a trailing slash", `${GITHUB_OIDC_ISSUER}/`],
      ["plain http", GITHUB_OIDC_ISSUER.replace("https:", "http:")],
      ["GitHub Enterprise's issuer form", `${GITHUB_OIDC_ISSUER}/acme`],
    ])("is refused from %s as issuer", async (_label, issuer) => {
      expect((await refusal(await token({}, { issuer }))).status).toBe(401);
    });

    it.each([
      ["an audience it shares a prefix with", `${PLATFORM_SECRETS_AUDIENCE}-admin`],
      ["no audience the platform names", "https://github.com/acme"],
    ])("is refused for %s", async (_label, audience) => {
      expect((await refusal(await token({}, { audience }))).status).toBe(401);
    });

    it.each([
      ["the owner's case changed", "ACME/platform"],
      ["a fork with a suffix", "acme/platform-fork"],
      ["another owner, same name", "mallory/platform"],
      ["a path appended", "acme/platform/extra"],
    ])("is refused from a repository with %s", async (_label, repository) => {
      const err = await refusal(await token({ repository }));
      expect(err.status).toBe(403);
      expect(db.select).not.toHaveBeenCalled();
    });

    it.each([
      ["the environment's case changed", `repo:${REPO}:environment:TENANT-${TENANT_ID}`],
      ["a suffix on the environment", `repo:${REPO}:environment:tenant-${TENANT_ID}-staging`],
      ["the tenant ID truncated", `repo:${REPO}:environment:tenant-${TENANT_ID.slice(0, -1)}`],
      ["the deploy branch, no environment", `repo:${REPO}:ref:refs/heads/main`],
      ["a pull request", `repo:${REPO}:pull_request`],
      ["the right environment in a fork", `repo:mallory/platform:environment:tenant-${TENANT_ID}`],
    ])("is refused with a subject naming %s", async (_label, sub) => {
      const err = await refusal(await token({ sub }));
      expect(err.status).toBe(403);
      expect(db.update).not.toHaveBeenCalled();
      expect(decryptSecret).not.toHaveBeenCalled();
    });

    it("is refused when a claim has the wrong type", async () => {
      expect((await refusal(await token({ run_id: 4242 }))).status).toBe(401);
      expect((await refusal(await token({ sub: [SUBJECT] }))).status).toBe(401);
    });
  });

  describe("who is asking", () => {
    // Any repository can mint a token for this audience.
    it("refuses another repository before touching the database", async () => {
      const err = await refusal(await token({ repository: "mallory/fork" }));

      expect(err.status).toBe(403);
      expect(db.select).not.toHaveBeenCalled();
      expect(db.update).not.toHaveBeenCalled();
    });

    it("refuses a run in another tenant's environment", async () => {
      const other = `repo:${REPO}:environment:tenant-00000000-0000-4000-8000-000000000999`;
      const err = await refusal(await token({ sub: other }));

      expect(err.status).toBe(403);
      expect(db.update).not.toHaveBeenCalled();
    });

    // The connection check runs in the same environment, so the subject alone
    // would let it through.
    it("refuses the verify workflow even in the right environment", async () => {
      const verifyRef = `${REPO}/.github/workflows/verify-tenant-azure.yml@refs/heads/main`;
      expect((await refusal(await token({ workflow_ref: verifyRef }))).status).toBe(403);
    });

    it("refuses the deploy workflow run from a different branch", async () => {
      const branchRef = `${REPO}/.github/workflows/deploy-tenant-azure.yml@refs/heads/feature`;
      expect((await refusal(await token({ workflow_ref: branchRef }))).status).toBe(403);
    });

    it("follows CHATBOT_DEPLOY_REF", async () => {
      process.env.CHATBOT_DEPLOY_REF = "release";
      const releaseRef = `${REPO}/.github/workflows/deploy-tenant-azure.yml@refs/heads/release`;

      await expect(release(await token({ workflow_ref: releaseRef }))).resolves.toHaveProperty("llmApiKey");
    });

    it("refuses the deploy workflow asking for a teardown's secrets", async () => {
      dbSelectWhere.mockResolvedValue([
        { deployment: { ...deployDeployment, kind: "destroy" }, tenant: azureTenant },
      ]);
      expect((await refusal(await token())).status).toBe(403);
    });
  });

  describe("the deployment", () => {
    it("must exist", async () => {
      dbSelectWhere.mockResolvedValue([]);
      expect((await refusal(await token())).status).toBe(404);
    });

    it("must be an Azure one — AWS keys never leave the customer's account", async () => {
      dbSelectWhere.mockResolvedValue([
        { deployment: deployDeployment, tenant: { ...azureTenant, cloudProvider: "aws" } },
      ]);
      const err = await refusal(await token());

      expect(err.status).toBe(409);
      expect(decryptSecret).not.toHaveBeenCalled();
    });

    // Already claimed, finished, or pinned to another run: the conditional
    // update matches nothing.
    it("releases nothing when the claim matches no row", async () => {
      dbUpdateReturning.mockResolvedValue([]);
      const err = await refusal(await token());

      expect(err.status).toBe(409);
      expect(decryptSecret).not.toHaveBeenCalled();
    });

    // Two runs racing for one deployment both pass every claim check; the
    // conditional UPDATE is what lets only one of them through. The mock
    // stands in for Postgres matching the row once.
    it("releases to only one of two runs racing for the same deployment", async () => {
      dbUpdateReturning.mockResolvedValueOnce([{ id: DEPLOYMENT_ID }]).mockResolvedValueOnce([]);

      const results = await Promise.allSettled([
        release(await token({ run_id: "4242" })),
        release(await token({ run_id: "4343" })),
      ]);

      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
      expect(rejected).toHaveLength(1);
      expect(rejected[0].reason).toMatchObject({ status: 409 });
    });

    it("records the claim and the run in one update", async () => {
      await release(await token());

      const set = vi.mocked(db.update).mock.results[0].value.set;
      expect(set.mock.calls[0][0]).toMatchObject({ secretsClaimedAt: expect.any(Date) });
      expect(set.mock.calls[0][0]).toHaveProperty("githubRunId");
    });
  });
});
