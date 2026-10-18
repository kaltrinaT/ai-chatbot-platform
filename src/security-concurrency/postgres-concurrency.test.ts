/**
 * SEC-CONC — Concurrency guarantees under real PostgreSQL.
 *
 * SEC-E2E-01 and 03 run against PGlite, which executes one statement at a
 * time on one connection: two "concurrent" requests interleave between
 * statements but never inside one. These scenarios repeat the races against a
 * PostgreSQL 16 server in Docker through a connection pool, so parallel
 * requests are parallel transactions, and the guarantees rest on what
 * Postgres itself does: a unique index rejecting the second insert, and an
 * UPDATE that waits for a row lock and then re-checks its WHERE clause
 * against the committed row (READ COMMITTED's re-evaluation).
 *
 * Each scenario runs ROUNDS rounds of PARALLEL simultaneous requests and
 * counts rounds in which the guarantee broke. Where the code has a read check
 * in front of an atomic write, it also counts requests that got past the read
 * — the measure of how often requests truly overlapped. A negative control
 * repeats the first race with the unique index dropped, to show what the index
 * prevents.
 *
 * Needs CONCURRENCY_DATABASE_URL; scripts/evaluate-postgres-concurrency.cjs
 * starts the container and sets it.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, type JWTVerifyGetKey } from "jose";
import { evidence, fixtureSecret, outcome } from "@/test/evidence";
import { buildFormData } from "@/test/form-data";

const PARALLEL = Number(process.env.CONCURRENCY_PARALLEL ?? 25);
const ROUNDS = Number(process.env.CONCURRENCY_ROUNDS ?? 20);

const h = vi.hoisted(() => ({
  pool: null as null | import("pg").Pool,
  session: null as null | { user: { id: string } },
  dispatches: [] as string[],
}));

vi.mock("@/db", async () => {
  const { Pool } = await import("pg");
  const { drizzle } = await import("drizzle-orm/node-postgres");
  const schema = await import("@/db/schema");
  const url = process.env.CONCURRENCY_DATABASE_URL;
  if (!url) throw new Error("CONCURRENCY_DATABASE_URL is not set; run scripts/evaluate-postgres-concurrency.cjs");
  h.pool = new Pool({ connectionString: url, max: Number(process.env.CONCURRENCY_PARALLEL ?? 25) + 5 });
  return { db: drizzle(h.pool, { schema }) };
});
vi.mock("@/auth", () => ({ auth: vi.fn(async () => h.session) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/lib/github", () => ({
  getChatbotRepo: () => ({ owner: "acme", repo: "platform" }),
  getDeployWorkflowId: () => "deploy-tenant.yml",
  getDestroyWorkflowId: () => "destroy-tenant.yml",
  getOctokit: () => ({
    actions: {
      createWorkflowDispatch: vi.fn(async (req: { inputs: Record<string, string> }) => {
        h.dispatches.push(req.inputs.tenant_id);
      }),
    },
  }),
  fetchRunProgress: vi.fn(),
  findRunForDeployment: vi.fn(async () => null),
}));
vi.mock("@/lib/docsSigner", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/docsSigner")>()),
  deleteViaSigner: vi.fn(async () => undefined),
}));
vi.mock("@/lib/reindex", () => ({ triggerReindex: vi.fn(async () => ({ ok: true })) }));

import { redeployTenant } from "@/app/tenants/[id]/actions";
import { POST as statusCallback } from "@/app/api/deployments/[id]/status/route";
import { releaseDeploymentSecrets } from "@/lib/deploymentSecrets";
import { encryptSecret } from "@/lib/crypto";
import { GITHUB_OIDC_ISSUER, PLATFORM_SECRETS_AUDIENCE, tenantDeploySubject } from "@/lib/githubOidc";

const record = evidence("SEC-CONC");

const ALICE = "user-alice";
const BOB = "user-bob";
const TENANT_A = "a0000000-0000-4000-8000-00000000000a";
const TENANT_B = "b0000000-0000-4000-8000-00000000000b";
const TENANT_Z = "e0000000-0000-4000-8000-00000000000e"; // Azure, for the secrets release
const WEBHOOK_SECRET = fixtureSecret("conc-webhook-secret-5e4d3c2b1a09");
const ENCRYPTION_KEY = fixtureSecret("5d".repeat(32));
const DEPLOY_REF = "acme/platform/.github/workflows/deploy-tenant-azure.yml@refs/heads/main";

process.env.PLATFORM_CHATBOT_IMAGE_URI = "111111111111.dkr.ecr.eu-central-1.amazonaws.com/chatbot-backend";
process.env.PLATFORM_FRONTEND_IMAGE_URI = "111111111111.dkr.ecr.eu-central-1.amazonaws.com/chatbot-frontend";
process.env.DEPLOY_WEBHOOK_SECRET = WEBHOOK_SECRET;
process.env.PLATFORM_ENCRYPTION_KEY = ENCRYPTION_KEY;

const sql = async <T = Record<string, unknown>>(text: string, params: unknown[] = []) =>
  (await h.pool!.query(text, params)).rows as T[];

async function migrate() {
  await sql("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  const root = process.cwd();
  const journal = JSON.parse(readFileSync(path.join(root, "drizzle/meta/_journal.json"), "utf8")) as { entries: { tag: string }[] };
  for (const { tag } of journal.entries) {
    for (const statement of readFileSync(path.join(root, "drizzle", `${tag}.sql`), "utf8").split("--> statement-breakpoint")) {
      if (statement.trim()) await sql(statement);
    }
  }
}

function awsTenant(id: string, owner: string, slug: string) {
  return [id, slug, slug, owner, "aws", "111122223333", "eu-central-1", `arn:aws:iam::111122223333:role/chatbot-client-deploy-${slug}`,
    "openai", "000000000000000000000000:00000000000000000000000000000000:00",
    `arn:aws:secretsmanager:eu-central-1:111122223333:secret:${slug}/llm`, `arn:aws:secretsmanager:eu-central-1:111122223333:secret:${slug}/signer`, "pgvector"];
}

async function reset() {
  await sql("TRUNCATE users, tenants, deployments, tenant_documents RESTART IDENTITY CASCADE");
  await sql("INSERT INTO users (id, email) VALUES ($1, 'alice@example.com'), ($2, 'bob@example.com')", [ALICE, BOB]);
  const columns = "id, name, slug, owner_user_id, cloud_provider, aws_account_id, aws_region, deployment_role_arn, llm_provider, llm_api_key_encrypted, llm_secret_arn, docs_signer_secret_arn, vector_store";
  for (const t of [awsTenant(TENANT_A, ALICE, "alpha"), awsTenant(TENANT_B, BOB, "beta")]) {
    await sql(`INSERT INTO tenants (${columns}) VALUES (${t.map((_, i) => `$${i + 1}`).join(", ")})`, t);
  }
  await sql(
    `INSERT INTO tenants (id, name, slug, owner_user_id, cloud_provider, azure_subscription_id, azure_tenant_id, azure_client_id, azure_region,
       llm_provider, llm_api_key_encrypted, vector_store, docs_signer_secret_encrypted)
     VALUES ($1, 'zeta', 'zeta', $2, 'azure', '11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222',
       '33333333-3333-4333-8333-333333333333', 'swedencentral', 'openai', $3, 'pgvector', $4)`,
    [TENANT_Z, ALICE, encryptSecret(fixtureSecret("sk-conc-zeta-llm-key-00112233445566778899")), encryptSecret(fixtureSecret("conc-zeta-signer-0a1b2c3d"))],
  );
  h.dispatches.length = 0;
}

/** Calls `fn` signed in as `user`. The session is read when the action starts. */
function as<T>(user: string, fn: () => Promise<T>): Promise<T> {
  h.session = { user: { id: user } };
  return fn();
}

const activeDeployments = async (tenantId: string) =>
  Number((await sql<{ n: string }>("SELECT count(*) AS n FROM deployments WHERE tenant_id = $1 AND status IN ('pending', 'running')", [tenantId]))[0].n);

async function runningDeployment(tenantId: string) {
  return (await sql<{ id: string }>(
    "INSERT INTO deployments (tenant_id, triggered_by_user_id, chatbot_version, status) VALUES ($1, $2, 'latest', 'running') RETURNING id",
    [tenantId, ALICE],
  ))[0].id;
}

beforeAll(async () => {
  await migrate();
  // Open every pooled connection first, so the rounds race on queries rather
  // than on connection set-up, which would serialise the first round.
  await Promise.all(Array.from({ length: PARALLEL + 5 }, () => sql("SELECT pg_sleep(0.05)")));
}, 120_000);

afterAll(async () => {
  await h.pool?.end();
});

describe("SEC-CONC · real PostgreSQL, parallel transactions", () => {
  it(`${PARALLEL} simultaneous redeploys of one tenant start exactly one deployment, every round`, async () => {
    const rounds = [];
    for (let r = 0; r < ROUNDS; r++) {
      await reset();
      const results = await Promise.all(Array.from({ length: PARALLEL }, () => as(ALICE, () => outcome(() => redeployTenant(buildFormData({ tenantId: TENANT_A }))))));
      rounds.push({
        succeeded: results.filter((x) => x.ok).length,
        inProgress: results.filter((x) => !x.ok && /DeploymentInProgressError/.test(x.error)).length,
        other: results.filter((x) => !x.ok && !/DeploymentInProgressError/.test(x.error)).map((x) => (x.ok ? "" : x.error)),
        active: await activeDeployments(TENANT_A),
        dispatches: h.dispatches.length,
      });
    }
    const broken = rounds.filter((x) => x.succeeded !== 1 || x.active !== 1 || x.dispatches !== 1 || x.other.length);
    record.attack(`${PARALLEL} parallel redeploys × ${ROUNDS} rounds`, {
      expected: "every round: one dispatched, the rest refused as in progress, one active row",
      actual: { rounds: ROUNDS, parallel: PARALLEL, roundsBroken: broken.length, refusedAsInProgress: rounds.reduce((n, x) => n + x.inProgress, 0), otherErrors: [...new Set(rounds.flatMap((x) => x.other))] },
      refused: broken.length === 0,
    });
    expect(broken).toEqual([]);
  });

  it("negative control: with the unique index dropped, the same race starts many deployments", async () => {
    await sql('DROP INDEX "deployments_one_active_per_tenant"');
    try {
      const rounds = [];
      for (let r = 0; r < Math.min(ROUNDS, 5); r++) {
        await reset();
        await Promise.all(Array.from({ length: PARALLEL }, () => as(ALICE, () => outcome(() => redeployTenant(buildFormData({ tenantId: TENANT_A }))))));
        rounds.push(await activeDeployments(TENANT_A));
      }
      record.control("The same race without the index (negative control)", {
        expected: "duplicates appear, showing the index is what prevents them",
        actual: { activeRowsPerRound: rounds },
        allowed: rounds.some((n) => n > 1),
      });
      expect(rounds.some((n) => n > 1)).toBe(true);
    } finally {
      await reset();
      await sql(`CREATE UNIQUE INDEX "deployments_one_active_per_tenant" ON "deployments" USING btree ("tenant_id") WHERE "deployments"."status" IN ('pending', 'running')`);
    }
  });

  it(`${PARALLEL} simultaneous terminal callbacks finish a deployment once, every round`, async () => {
    const rounds = [];
    for (let r = 0; r < ROUNDS; r++) {
      await reset();
      const id = await runningDeployment(TENANT_A);
      const responses = await Promise.all(
        Array.from({ length: PARALLEL }, (_, i) =>
          statusCallback(
            new Request(`http://platform/api/deployments/${id}/status`, {
              method: "POST",
              headers: { "x-webhook-secret": WEBHOOK_SECRET },
              body: JSON.stringify(i % 2 ? { status: "failed", errorMessage: `run ${i}` } : { status: "succeeded" }),
            }),
            { params: Promise.resolve({ id }) },
          ),
        ),
      );
      const bodies = await Promise.all(responses.map(async (res) => ({ status: res.status, error: ((await res.json()) as { error?: string }).error ?? "" })));
      const [row] = await sql<{ status: string; error_message: string | null }>("SELECT status, error_message FROM deployments WHERE id = $1", [id]);
      rounds.push({
        ok: bodies.filter((b) => b.status === 200).length,
        // Got past the read check, stopped only by the conditional UPDATE.
        stoppedByAtomicWrite: bodies.filter((b) => /finished concurrently/.test(b.error)).length,
        stoppedByReadCheck: bodies.filter((b) => /already/.test(b.error)).length,
        final: row.status,
      });
    }
    const broken = rounds.filter((x) => x.ok !== 1);
    record.attack(`${PARALLEL} parallel terminal callbacks × ${ROUNDS} rounds`, {
      expected: "every round: exactly one callback applied",
      actual: {
        roundsBroken: broken.length,
        stoppedByAtomicWrite: rounds.reduce((n, x) => n + x.stoppedByAtomicWrite, 0),
        stoppedByReadCheck: rounds.reduce((n, x) => n + x.stoppedByReadCheck, 0),
        roundsWithOverlap: rounds.filter((x) => x.stoppedByAtomicWrite > 0).length,
      },
      refused: broken.length === 0,
    });
    expect(broken).toEqual([]);
  });

  it(`${PARALLEL} simultaneous secrets claims for one deployment release once, every round`, async () => {
    const pair = await generateKeyPair("RS256", { extractable: true });
    const keys: JWTVerifyGetKey = createLocalJWKSet({ keys: [{ ...(await exportJWK(pair.publicKey)), kid: "gh", alg: "RS256" }] });
    const token = (runId: string) =>
      new SignJWT({ sub: tenantDeploySubject({ owner: "acme", repo: "platform" }, TENANT_Z), repository: "acme/platform", workflow_ref: DEPLOY_REF, run_id: runId })
        .setProtectedHeader({ alg: "RS256", kid: "gh" })
        .setIssuer(GITHUB_OIDC_ISSUER)
        .setAudience(PLATFORM_SECRETS_AUDIENCE)
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(pair.privateKey);

    const rounds = [];
    for (let r = 0; r < ROUNDS; r++) {
      await reset();
      const id = await runningDeployment(TENANT_Z);
      const tokens = await Promise.all(Array.from({ length: PARALLEL }, (_, i) => token(`run-${r}-${i}`)));
      const results = await Promise.all(tokens.map((t) => outcome(() => releaseDeploymentSecrets(id, t, keys))));
      const [row] = await sql<{ github_run_id: string | null }>("SELECT github_run_id FROM deployments WHERE id = $1", [id]);
      rounds.push({ released: results.filter((x) => x.ok).length, runId: row.github_run_id });
    }
    const broken = rounds.filter((x) => x.released !== 1 || !x.runId);
    record.attack(`${PARALLEL} parallel secrets claims × ${ROUNDS} rounds`, {
      expected: "every round: secrets released to exactly one run, which the row names",
      actual: { roundsBroken: broken.length, releasedPerRound: [...new Set(rounds.map((x) => x.released))] },
      refused: broken.length === 0,
    });
    expect(broken).toEqual([]);
  });

  it("an attacker's parallel burst neither reaches a foreign tenant nor blocks its owner", async () => {
    const rounds = [];
    for (let r = 0; r < ROUNDS; r++) {
      await reset();
      const attempts = Array.from({ length: PARALLEL }, () => as(ALICE, () => outcome(() => redeployTenant(buildFormData({ tenantId: TENANT_B })))));
      const owner = as(BOB, () => outcome(() => redeployTenant(buildFormData({ tenantId: TENANT_B }))));
      const [attacks, own] = await Promise.all([Promise.all(attempts), owner]);
      rounds.push({ attackerSucceeded: attacks.filter((x) => x.ok).length, ownerSucceeded: own.ok, dispatches: [...h.dispatches] });
    }
    const broken = rounds.filter((x) => x.attackerSucceeded > 0 || !x.ownerSucceeded || x.dispatches.length !== 1);
    record.attack(`${PARALLEL} parallel cross-tenant redeploys beside the owner's × ${ROUNDS} rounds`, {
      expected: "every round: all attacker requests refused, the owner's one deployment dispatched",
      actual: { roundsBroken: broken.length },
      refused: broken.length === 0,
    });
    record.control("The owner's own redeploy during the burst", {
      expected: "succeeds every round",
      actual: { ownerSucceededRounds: rounds.filter((x) => x.ownerSucceeded).length, rounds: ROUNDS },
      allowed: rounds.every((x) => x.ownerSucceeded),
    });
    expect(broken).toEqual([]);
  });
});
