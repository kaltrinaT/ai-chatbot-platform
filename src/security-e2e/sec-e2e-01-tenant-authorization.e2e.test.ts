/**
 * SEC-E2E-01 — Cross-tenant authorization.
 *
 * Claim: an operator can act on their own tenants and on nothing else, and
 * the deployment webhooks change a deployment only forward and only once.
 *
 * Runs the real server actions, API routes and deploy logic against a real
 * Postgres (PGlite, migrated with the repository's own migrations). Only the
 * edges are replaced: who is signed in, GitHub's dispatch API, and the
 * tenant's own docs-signer and chatbot backend, each of which records what it
 * was asked to do. Every refusal is paired with the same operation on the
 * operator's own tenant, and the database is read back after each one.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { evidence, fixtureSecret, outcome } from "@/test/evidence";
import { buildFormData } from "@/test/form-data";

const h = vi.hoisted(() => ({
  client: null as null | import("@electric-sql/pglite").PGlite,
  session: null as null | { user: { id: string } },
  dispatches: [] as { workflow_id: string; inputs: Record<string, string> }[],
  presigned: [] as string[],
  signerDeletes: [] as { tenantId: string; objectKey: string }[],
  reindexed: [] as string[],
}));

vi.mock("@/db", async () => {
  const { migratedDatabase } = await import("@/test/pglite-db");
  const { client, db } = await migratedDatabase();
  h.client = client;
  return { db };
});
vi.mock("@/auth", () => ({ auth: vi.fn(async () => h.session) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((to: string) => {
    throw new Error(`NEXT_REDIRECT ${to}`);
  }),
}));
vi.mock("@/lib/github", () => ({
  getChatbotRepo: () => ({ owner: "acme", repo: "platform" }),
  getDeployWorkflowId: () => "deploy-tenant.yml",
  getDestroyWorkflowId: () => "destroy-tenant.yml",
  getOctokit: () => ({
    actions: {
      createWorkflowDispatch: vi.fn(async (req: { workflow_id: string; inputs: Record<string, string> }) => {
        h.dispatches.push({ workflow_id: req.workflow_id, inputs: req.inputs });
      }),
    },
  }),
  fetchRunProgress: vi.fn(async () => ({ runStatus: "in_progress", runConclusion: null })),
  findRunForDeployment: vi.fn(async () => null),
}));
vi.mock("@/lib/docsSigner", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/docsSigner")>()),
  presignUpload: vi.fn(async (tenant: { id: string }, file: { fileName: string }) => {
    h.presigned.push(tenant.id);
    return { url: "https://signer.example/upload", objectKey: `${tenant.id}/${file.fileName}`, fields: {} };
  }),
  deleteViaSigner: vi.fn(async (tenant: { id: string }, objectKey: string) => {
    h.signerDeletes.push({ tenantId: tenant.id, objectKey });
  }),
}));
vi.mock("@/lib/reindex", () => ({
  triggerReindex: vi.fn(async (tenant: { slug: string }) => {
    h.reindexed.push(tenant.slug);
    return { ok: true };
  }),
}));

import { db } from "@/db";
import { deployments, tenantDocuments, tenantDrafts, tenants, users } from "@/db/schema";
import { redeployTenant, deleteTenant } from "@/app/tenants/[id]/actions";
import { requestUploadUrl, deleteDocument, confirmUpload, abandonUpload } from "@/app/tenants/[id]/documents/actions";
import { saveTenantDraft, deleteTenantDraft } from "@/app/tenants/new/actions";
import { GET as deploymentProgress } from "@/app/api/deployments/[id]/progress/route";
import { POST as statusCallback } from "@/app/api/deployments/[id]/status/route";
import { reconcileCompletedRun } from "@/lib/reconcile";

const record = evidence("SEC-E2E-01");

const ALICE = "user-alice";
const BOB = "user-bob";
const TENANT_A = "a0000000-0000-4000-8000-00000000000a"; // Alice's
const TENANT_B = "b0000000-0000-4000-8000-00000000000b"; // Bob's
const TENANT_C = "c0000000-0000-4000-8000-00000000000c"; // Alice's, deleted
const DEPLOY_A = "da000000-0000-4000-8000-0000000000da";
const DEPLOY_B = "db000000-0000-4000-8000-0000000000db";
const DOC_A = "ca000000-0000-4000-8000-0000000000ca";
const DOC_B = "cb000000-0000-4000-8000-0000000000cb";
const WEBHOOK_SECRET = fixtureSecret("e2e-webhook-secret-6f1d2c9b8a7e");

process.env.PLATFORM_CHATBOT_IMAGE_URI = "111111111111.dkr.ecr.eu-central-1.amazonaws.com/chatbot-backend";
process.env.PLATFORM_FRONTEND_IMAGE_URI = "111111111111.dkr.ecr.eu-central-1.amazonaws.com/chatbot-frontend";
process.env.DEPLOY_WEBHOOK_SECRET = WEBHOOK_SECRET;

function awsTenant(id: string, owner: string, slug: string) {
  return {
    id,
    name: slug,
    slug,
    ownerUserId: owner,
    cloudProvider: "aws" as const,
    awsAccountId: "111122223333",
    awsRegion: "eu-central-1",
    deploymentRoleArn: `arn:aws:iam::111122223333:role/chatbot-client-deploy-${slug}`,
    llmProvider: "openai" as const,
    llmApiKeyEncrypted: "000000000000000000000000:00000000000000000000000000000000:00",
    llmSecretArn: `arn:aws:secretsmanager:eu-central-1:111122223333:secret:${slug}/llm`,
    docsSignerSecretArn: `arn:aws:secretsmanager:eu-central-1:111122223333:secret:${slug}/signer`,
    docsSignerUrl: `https://${slug}.lambda-url.eu-central-1.on.aws/`,
    vectorStore: "pgvector" as const,
  };
}

async function reset() {
  await h.client!.exec("TRUNCATE users, tenants, deployments, tenant_documents RESTART IDENTITY CASCADE");
  await db.insert(users).values([
    { id: ALICE, email: "alice@example.com" },
    { id: BOB, email: "bob@example.com" },
  ]);
  await db.insert(tenants).values([
    awsTenant(TENANT_A, ALICE, "alpha"),
    awsTenant(TENANT_B, BOB, "beta"),
    { ...awsTenant(TENANT_C, ALICE, "gamma"), deletedAt: new Date("2026-10-01T00:00:00Z"), llmApiKeyEncrypted: null },
  ]);
  const finished = { kind: "deploy" as const, status: "succeeded" as const, chatbotVersion: "latest", finishedAt: new Date("2026-10-01T10:12:00Z") };
  await db.insert(deployments).values([
    { id: DEPLOY_A, tenantId: TENANT_A, triggeredByUserId: ALICE, ...finished },
    { id: DEPLOY_B, tenantId: TENANT_B, triggeredByUserId: BOB, ...finished },
  ]);
  const doc = { objectKey: "", displayName: "handbook.pdf", contentType: "application/pdf", sizeBytes: 1024, status: "uploaded" as const };
  await db.insert(tenantDocuments).values([
    { ...doc, id: DOC_A, tenantId: TENANT_A, objectKey: `${TENANT_A}/handbook.pdf`, uploadedByUserId: ALICE },
    { ...doc, id: DOC_B, tenantId: TENANT_B, objectKey: `${TENANT_B}/handbook.pdf`, uploadedByUserId: BOB },
  ]);
  h.dispatches.length = 0;
  h.presigned.length = 0;
  h.signerDeletes.length = 0;
  h.reindexed.length = 0;
}

/** What the database holds for one tenant, read back after an operation. */
async function stateOf(tenantId: string) {
  const { rows: t } = await h.client!.query<{ deleted_at: string | null }>(
    "SELECT deleted_at FROM tenants WHERE id = $1",
    [tenantId],
  );
  const { rows: d } = await h.client!.query<{ kind: string; status: string }>(
    "SELECT kind, status FROM deployments WHERE tenant_id = $1 ORDER BY started_at",
    [tenantId],
  );
  const { rows: docs } = await h.client!.query<{ id: string; status: string }>(
    "SELECT id, status FROM tenant_documents WHERE tenant_id = $1 ORDER BY id",
    [tenantId],
  );
  return { deleted: t[0]?.deleted_at !== null, deployments: d, documents: docs };
}

/** Nothing outside the platform was asked to act. */
function edges() {
  return {
    dispatches: h.dispatches.length,
    presigned: [...h.presigned],
    signerDeletes: h.signerDeletes.length,
    reindexed: [...h.reindexed],
  };
}

const signedInAs = (user: string | null) => {
  h.session = user ? { user: { id: user } } : null;
};
const tenantForm = (tenantId: string) => buildFormData({ tenantId });
const progress = (id: string) =>
  deploymentProgress(new Request(`http://platform/api/deployments/${id}/progress`), { params: Promise.resolve({ id }) });
const callback = (id: string, body: unknown, secret = WEBHOOK_SECRET) =>
  statusCallback(
    new Request(`http://platform/api/deployments/${id}/status`, {
      method: "POST",
      headers: { "x-webhook-secret": secret },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );

beforeEach(async () => {
  await reset();
  signedInAs(ALICE);
});

describe("SEC-E2E-01 · operator A cannot operate on tenant B", () => {
  it("redeploy", async () => {
    const before = await stateOf(TENANT_B);
    const attack = await outcome(() => redeployTenant(tenantForm(TENANT_B)));
    const after = await stateOf(TENANT_B);
    record.attack("Alice redeploys Bob's tenant", {
      expected: "refused; no deployment row for B; nothing dispatched",
      actual: { result: attack, deploymentsBefore: before.deployments.length, deploymentsAfter: after.deployments.length, ...edges() },
      refused: !attack.ok && after.deployments.length === before.deployments.length && h.dispatches.length === 0,
    });
    expect(attack.ok).toBe(false);
    expect(after).toEqual(before);
    expect(h.dispatches).toHaveLength(0);

    const control = await outcome(() => redeployTenant(tenantForm(TENANT_A)));
    const own = await stateOf(TENANT_A);
    record.control("Alice redeploys her own tenant", {
      expected: "dispatched; a running deployment row for A",
      actual: { result: control.ok, deployments: own.deployments, dispatchedFor: h.dispatches.map((d) => d.inputs.tenant_id) },
      allowed: control.ok && h.dispatches[0]?.inputs.tenant_id === TENANT_A,
    });
    expect(control.ok).toBe(true);
    expect(h.dispatches.map((d) => d.inputs.tenant_id)).toEqual([TENANT_A]);
    expect(own.deployments.at(-1)).toEqual({ kind: "deploy", status: "running" });
  });

  it("teardown", async () => {
    const before = await stateOf(TENANT_B);
    const attack = await outcome(() => deleteTenant(tenantForm(TENANT_B)));
    const after = await stateOf(TENANT_B);
    record.attack("Alice tears down Bob's tenant", {
      expected: "refused; B not deleted; no destroy row; B's documents untouched",
      actual: { result: attack, after, ...edges() },
      refused: !attack.ok && !after.deleted && after.deployments.length === before.deployments.length && h.signerDeletes.length === 0,
    });
    expect(attack.ok).toBe(false);
    expect(after).toEqual(before);
    expect(h.signerDeletes).toHaveLength(0);

    const control = await outcome(() => deleteTenant(tenantForm(TENANT_A)));
    const own = await stateOf(TENANT_A);
    record.control("Alice tears down her own tenant", {
      expected: "a destroy deployment for A is dispatched, A's documents emptied through A's signer",
      actual: { result: control.ok, deployments: own.deployments, signerDeletes: h.signerDeletes },
      allowed: control.ok && own.deployments.at(-1)?.kind === "destroy",
    });
    expect(control.ok).toBe(true);
    expect(own.deployments.at(-1)).toEqual({ kind: "destroy", status: "running" });
    expect(h.signerDeletes.every((d) => d.tenantId === TENANT_A)).toBe(true);
  });

  it("deployment API", async () => {
    const attack = await progress(DEPLOY_B);
    const body = await attack.text();
    record.attack("Alice reads Bob's deployment through the API", {
      expected: "404, and nothing of B's in the body",
      actual: { status: attack.status, mentionsB: body.includes(TENANT_B) || body.includes(DEPLOY_B) },
      refused: attack.status === 404 && !body.includes(DEPLOY_B),
    });
    expect(attack.status).toBe(404);
    expect(body).not.toContain(DEPLOY_B);

    const control = await progress(DEPLOY_A);
    record.control("Alice reads her own deployment", {
      expected: "200 with the deployment",
      actual: { status: control.status },
      allowed: control.status === 200,
    });
    expect(control.status).toBe(200);
  });

  it("upload authorization", async () => {
    const attack = await requestUploadUrl(TENANT_B, "x.pdf", "application/pdf", 10);
    const after = await stateOf(TENANT_B);
    record.attack("Alice requests an upload URL for Bob's tenant", {
      expected: "refused before B's signer is called; no document row added",
      actual: { result: attack, documents: after.documents.length, presigned: [...h.presigned] },
      refused: !attack.ok && h.presigned.length === 0 && after.documents.length === 1,
    });
    expect(attack.ok).toBe(false);
    expect(h.presigned).toEqual([]);
    expect(after.documents).toHaveLength(1);

    const control = await requestUploadUrl(TENANT_A, "x.pdf", "application/pdf", 10);
    const own = await stateOf(TENANT_A);
    record.control("Alice requests an upload URL for her own tenant", {
      expected: "A's signer presigns, a pending row is added to A",
      actual: { ok: control.ok, presigned: [...h.presigned], documents: own.documents.map((d) => d.status) },
      allowed: control.ok && h.presigned[0] === TENANT_A,
    });
    expect(control.ok).toBe(true);
    expect(h.presigned).toEqual([TENANT_A]);
    expect(own.documents.map((d) => d.status).sort()).toEqual(["pending", "uploaded"]);
  });

  it("document actions", async () => {
    const before = await stateOf(TENANT_B);
    const attacks = {
      delete: await outcome(() => deleteDocument(DOC_B)),
      confirm: await outcome(() => confirmUpload(DOC_B)),
      abandon: await outcome(() => abandonUpload(DOC_B)),
    };
    const after = await stateOf(TENANT_B);
    record.attack("Alice deletes, confirms and abandons Bob's document", {
      expected: "all refused; B's document row unchanged; B's signer and backend not called",
      actual: { results: attacks, documentsBefore: before.documents, documentsAfter: after.documents, ...edges() },
      refused: Object.values(attacks).every((a) => !a.ok) && JSON.stringify(after) === JSON.stringify(before) && h.signerDeletes.length === 0,
    });
    for (const a of Object.values(attacks)) expect(a.ok).toBe(false);
    expect(after).toEqual(before);
    expect(h.signerDeletes).toHaveLength(0);
    expect(h.reindexed).toEqual([]);

    const control = await outcome(() => deleteDocument(DOC_A));
    const own = await stateOf(TENANT_A);
    record.control("Alice deletes her own document", {
      expected: "deleted through A's signer, row removed, A reindexed",
      actual: { result: control.ok, documents: own.documents.length, signerDeletes: h.signerDeletes, reindexed: h.reindexed },
      allowed: control.ok && own.documents.length === 0 && h.signerDeletes[0]?.tenantId === TENANT_A,
    });
    expect(control.ok).toBe(true);
    expect(own.documents).toEqual([]);
    expect(h.reindexed).toEqual(["alpha"]);
  });
});

// Attack matrix — tenant authorization: the ID itself is the attack.
describe("SEC-E2E-01 · a manipulated tenant ID", () => {
  it.each([
    ["missing", ""],
    ["a guessed UUID", "7f3e9c1a-2b4d-4e6f-8a0b-1c2d3e4f5a6b"],
    ["Bob's ID upper-cased", TENANT_B.toUpperCase()],
    ["a SQL fragment", "' OR '1'='1"],
    ["Bob's ID with a trailing comment", `${TENANT_B}' --`],
  ])("%s reaches no tenant", async (label, tenantId) => {
    const redeploy = await outcome(() => redeployTenant(tenantForm(tenantId)));
    const upload = await outcome(() => requestUploadUrl(tenantId, "x.pdf", "application/pdf", 10));
    const uploadRefused = !upload.ok || upload.value.ok === false;
    const b = await stateOf(TENANT_B);
    record.attack(`Alice names ${label} as the tenant`, {
      expected: "refused; nothing dispatched or presigned; B unchanged",
      actual: { redeploy, upload, ...edges(), bDeployments: b.deployments.length },
      refused: !redeploy.ok && uploadRefused && h.dispatches.length === 0 && h.presigned.length === 0,
    });
    expect(redeploy.ok).toBe(false);
    expect(uploadRefused).toBe(true);
    expect(h.dispatches).toHaveLength(0);
    expect(h.presigned).toHaveLength(0);
    expect(b.deployments).toHaveLength(1);
  });

  // Postgres compares UUIDs by value, so case is not a way past the owner
  // check above — and not a way to lock an operator out of their own tenant.
  it("control: Alice's own ID upper-cased still reaches her tenant", async () => {
    const control = await outcome(() => redeployTenant(tenantForm(TENANT_A.toUpperCase())));
    record.control("Alice names her own tenant's ID upper-cased", {
      expected: "dispatched for A",
      actual: { result: control.ok, dispatchedFor: h.dispatches.map((d) => d.inputs.tenant_id) },
      allowed: control.ok && h.dispatches[0]?.inputs.tenant_id === TENANT_A,
    });
    expect(control.ok).toBe(true);
  });

  it("a deleted tenant of Alice's own cannot be acted on", async () => {
    const before = await stateOf(TENANT_C);
    const attempts = {
      redeploy: await outcome(() => redeployTenant(tenantForm(TENANT_C))),
      teardown: await outcome(() => deleteTenant(tenantForm(TENANT_C))),
      upload: await outcome(() => requestUploadUrl(TENANT_C, "x.pdf", "application/pdf", 10)),
    };
    const after = await stateOf(TENANT_C);
    const uploadRefused = !attempts.upload.ok || attempts.upload.value.ok === false;
    record.attack("Alice redeploys, tears down and uploads to her deleted tenant", {
      expected: "all refused; no deployment or document row added",
      actual: { attempts, before, after, ...edges() },
      refused: !attempts.redeploy.ok && !attempts.teardown.ok && uploadRefused && JSON.stringify(after) === JSON.stringify(before),
    });
    expect(attempts.redeploy.ok).toBe(false);
    expect(attempts.teardown.ok).toBe(false);
    expect(uploadRefused).toBe(true);
    expect(after).toEqual(before);
  });
});

// Attack matrix — tenant authorization, concurrent operations. Decided by the
// database's partial unique index, not by a read-then-write in the app.
describe("SEC-E2E-01 · concurrent operations", () => {
  it("a double-clicked redeploy starts exactly one deployment", async () => {
    const results = await Promise.all([1, 2].map(() => outcome(() => redeployTenant(tenantForm(TENANT_A)))));
    const own = await stateOf(TENANT_A);
    const active = own.deployments.filter((d) => d.status === "pending" || d.status === "running");
    record.attack("Two redeploys of one tenant at once", {
      expected: "one dispatched, one refused as in progress; one active row",
      actual: { results, active: active.length, dispatches: h.dispatches.length },
      refused: results.filter((r) => r.ok).length === 1 && active.length === 1 && h.dispatches.length === 1,
    });
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.find((r) => !r.ok)).toMatchObject({ error: expect.stringMatching(/DeploymentInProgressError/) });
    expect(active).toHaveLength(1);
    expect(h.dispatches).toHaveLength(1);
  });

  it("a redeploy racing a teardown of the same tenant lets only one run", async () => {
    const results = await Promise.all([
      outcome(() => redeployTenant(tenantForm(TENANT_A))),
      outcome(() => deleteTenant(tenantForm(TENANT_A))),
    ]);
    const active = (await stateOf(TENANT_A)).deployments.filter((d) => d.status === "running" || d.status === "pending");
    record.attack("A redeploy and a teardown of one tenant at once", {
      expected: "exactly one runs; Terraform state is never driven by two runs",
      actual: { results, active },
      refused: active.length === 1 && h.dispatches.length === 1,
    });
    expect(active).toHaveLength(1);
    expect(h.dispatches).toHaveLength(1);
  });

  it("a burst of cross-tenant requests is refused every time", async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, () => outcome(() => redeployTenant(tenantForm(TENANT_B)))),
    );
    const b = await stateOf(TENANT_B);
    record.attack("Five concurrent redeploys of Bob's tenant by Alice", {
      expected: "all refused; no row for B",
      actual: { refused: results.filter((r) => !r.ok).length, bDeployments: b.deployments.length, dispatches: h.dispatches.length },
      refused: results.every((r) => !r.ok) && b.deployments.length === 1 && h.dispatches.length === 0,
    });
    expect(results.every((r) => !r.ok)).toBe(true);
    expect(b.deployments).toHaveLength(1);
  });

  it("control: two operators deploying their own tenants at once each reach only their own", async () => {
    const [alice, bob] = await Promise.all([
      (async () => {
        signedInAs(ALICE);
        return outcome(() => redeployTenant(tenantForm(TENANT_A)));
      })(),
      (async () => {
        // Each server action reads the session once, at its start.
        await Promise.resolve();
        h.session = { user: { id: BOB } };
        return outcome(() => redeployTenant(tenantForm(TENANT_B)));
      })(),
    ]);
    const dispatched = h.dispatches.map((d) => d.inputs.tenant_id).sort();
    record.control("Alice and Bob redeploy their own tenants at once", {
      expected: "both dispatched, each for its own tenant",
      actual: { alice: alice.ok, bob: bob.ok, dispatched },
      allowed: alice.ok && bob.ok && dispatched.join() === [TENANT_A, TENANT_B].sort().join(),
    });
    expect(alice.ok && bob.ok).toBe(true);
    expect(dispatched).toEqual([TENANT_A, TENANT_B].sort());
  });
});

// Attack matrix — webhooks, against the real conditional UPDATE.
describe("SEC-E2E-01 · deployment webhooks", () => {
  async function runningDeployment() {
    const [d] = await db
      .insert(deployments)
      .values({ tenantId: TENANT_A, triggeredByUserId: ALICE, chatbotVersion: "latest", status: "running" })
      .returning();
    return d.id;
  }
  const row = async (id: string) =>
    (await h.client!.query<{ status: string; finished_at: string | null; error_message: string | null }>(
      "SELECT status, finished_at, error_message FROM deployments WHERE id = $1",
      [id],
    )).rows[0];

  it("a duplicate terminal callback is applied once", async () => {
    const id = await runningDeployment();
    const first = await callback(id, { status: "succeeded" });
    const settled = await row(id);
    const replay = await callback(id, { status: "failed", errorMessage: "replayed" });
    const after = await row(id);
    record.control("The run's own success callback", {
      expected: "200; deployment succeeded",
      actual: { status: first.status, row: settled.status },
      allowed: first.status === 200 && settled.status === "succeeded",
    });
    record.attack("The callback replayed, rewritten as a failure", {
      expected: "409; the row is byte-for-byte unchanged",
      actual: { status: replay.status, before: settled, after },
      refused: replay.status === 409 && JSON.stringify(after) === JSON.stringify(settled),
    });
    expect(first.status).toBe(200);
    expect(replay.status).toBe(409);
    expect(after).toEqual(settled);
  });

  it("concurrent terminal callbacks: the first to commit stands", async () => {
    const id = await runningDeployment();
    const responses = await Promise.all([
      callback(id, { status: "succeeded" }),
      callback(id, { status: "failed", errorMessage: "racing" }),
    ]);
    const statuses = responses.map((r) => r.status).sort();
    const final = await row(id);
    record.attack("Two terminal callbacks for one deployment at once", {
      expected: "one 200 and one 409; the row holds the winner's status only",
      actual: { statuses, final },
      refused: statuses.join() === "200,409" && ["succeeded", "failed"].includes(final.status),
    });
    expect(statuses).toEqual([200, 409]);
    const winner = responses[0].status === 200 ? "succeeded" : "failed";
    expect(final.status).toBe(winner);
  });

  it.each([
    ["moving back to pending", { status: "pending" }, 400],
    ["a malformed body", "{not json", 400],
    ["an unknown status", { status: "SUCCEEDED" }, 400],
  ])("refuses %s, leaving the row as it was", async (_label, body, expected) => {
    const id = await runningDeployment();
    const before = await row(id);
    const res = await callback(id, body);
    const after = await row(id);
    record.attack(`Webhook: ${_label}`, {
      expected: `${expected}; row unchanged`,
      actual: { status: res.status, before, after },
      refused: res.status === expected && JSON.stringify(after) === JSON.stringify(before),
    });
    expect(res.status).toBe(expected);
    expect(after).toEqual(before);
  });

  it("refuses a near-miss secret and a docs-signer URL on another host", async () => {
    const id = await runningDeployment();
    const forged = await callback(id, { status: "succeeded" }, `${WEBHOOK_SECRET.slice(0, -1)}x`);
    const hijack = await callback(id, { status: "succeeded", docsSignerUrl: "https://attacker.example/collect" });
    const { rows } = await h.client!.query<{ docs_signer_url: string }>("SELECT docs_signer_url FROM tenants WHERE id = $1", [TENANT_A]);
    record.attack("Webhook with a near-miss secret, then one redirecting the docs-signer", {
      expected: "401, then 400; the tenant's signer URL unchanged",
      actual: { forged: forged.status, hijack: hijack.status, signerUrl: rows[0].docs_signer_url, row: await row(id) },
      refused: forged.status === 401 && hijack.status === 400 && rows[0].docs_signer_url === "https://alpha.lambda-url.eu-central-1.on.aws/",
    });
    expect(forged.status).toBe(401);
    expect(hijack.status).toBe(400);
    expect(rows[0].docs_signer_url).toBe("https://alpha.lambda-url.eu-central-1.on.aws/");
    expect((await row(id)).status).toBe("running");
  });
});

// Attack matrix — one tenant's work reaches only that tenant's rows. Each write
// below is a conditional UPDATE or DELETE meant to match one row. With only one
// tenant's work in flight, a missing `id =` condition would go unnoticed (the
// generated mutants found exactly that), so both tenants have a running
// deployment and a pending upload here, and the other tenant's rows are read
// back after every operation.
describe("SEC-E2E-01 · one tenant's in-flight work stays its own", () => {
  const PENDING_A = "ea000000-0000-4000-8000-0000000000ea";
  const PENDING_B = "eb000000-0000-4000-8000-0000000000eb";
  let runA: string;
  let runB: string;

  beforeEach(async () => {
    const rows = await db
      .insert(deployments)
      .values([
        { tenantId: TENANT_A, triggeredByUserId: ALICE, chatbotVersion: "latest", status: "running" as const },
        { tenantId: TENANT_B, triggeredByUserId: BOB, chatbotVersion: "latest", status: "running" as const },
      ])
      .returning({ id: deployments.id, tenantId: deployments.tenantId });
    runA = rows.find((r) => r.tenantId === TENANT_A)!.id;
    runB = rows.find((r) => r.tenantId === TENANT_B)!.id;
    const pending = { displayName: "draft.pdf", contentType: "application/pdf", sizeBytes: 10, status: "pending" as const };
    await db.insert(tenantDocuments).values([
      { ...pending, id: PENDING_A, tenantId: TENANT_A, objectKey: `${TENANT_A}/draft.pdf`, uploadedByUserId: ALICE },
      { ...pending, id: PENDING_B, tenantId: TENANT_B, objectKey: `${TENANT_B}/draft.pdf`, uploadedByUserId: BOB },
    ]);
  });

  const deployment = async (id: string) =>
    (await h.client!.query<{ status: string; finished_at: string | null; error_message: string | null }>(
      "SELECT status, finished_at, error_message FROM deployments WHERE id = $1",
      [id],
    )).rows[0];
  const completedRun = (conclusion: string) => ({
    runStatus: "completed", runConclusion: conclusion, runStartedAt: null, htmlUrl: "https://github.com/acme/platform/actions/runs/1",
    updatedAt: "2026-10-18T10:00:00Z", currentJobName: null, currentStepName: null, stepsCompleted: 1, stepsTotal: 1,
  });

  it("a terminal callback for A's deployment changes only A's", async () => {
    const before = await deployment(runB);
    const res = await callback(runA, { status: "failed", errorMessage: "terraform apply failed" });
    const own = await deployment(runA);
    const after = await deployment(runB);
    record.control("A's run reports its own failure", {
      expected: "200; A's deployment failed",
      actual: { status: res.status, a: own.status },
      allowed: res.status === 200 && own.status === "failed",
    });
    record.attack("A's failure callback reaching B's running deployment", {
      expected: "B's row byte-for-byte unchanged",
      actual: { before, after },
      refused: JSON.stringify(after) === JSON.stringify(before),
    });
    expect(res.status).toBe(200);
    expect(own.status).toBe("failed");
    expect(after).toEqual(before);
  });

  it("reconciling A's finished run changes only A's, and never reopens a finished deployment", async () => {
    const before = await deployment(runB);
    const finishedBefore = await deployment(DEPLOY_B);
    await reconcileCompletedRun(runA, completedRun("success"), 1);
    await reconcileCompletedRun(DEPLOY_B, completedRun("failure"), 2);
    const own = await deployment(runA);
    const after = await deployment(runB);
    const finishedAfter = await deployment(DEPLOY_B);
    record.control("A's lost webhook reconciled from GitHub", {
      expected: "A's deployment succeeded",
      actual: { a: own.status },
      allowed: own.status === "succeeded",
    });
    record.attack("A's reconcile reaching B's running deployment, and a reconcile rewriting a finished one", {
      expected: "both of B's rows byte-for-byte unchanged",
      actual: { running: { before, after }, finished: { before: finishedBefore, after: finishedAfter } },
      refused: JSON.stringify(after) === JSON.stringify(before) && JSON.stringify(finishedAfter) === JSON.stringify(finishedBefore),
    });
    expect(own.status).toBe("succeeded");
    expect(after).toEqual(before);
    expect(finishedAfter).toEqual(finishedBefore);
  });

  it("a deployment of A's that went stale is failed alone", async () => {
    await h.client!.query("UPDATE deployments SET started_at = now() - interval '3 hours' WHERE id = $1", [runA]);
    const before = await deployment(runB);
    const res = await progress(runA);
    const own = await deployment(runA);
    const after = await deployment(runB);
    record.control("A's deployment, three hours old with no run, read through the API", {
      expected: "200; failed as stuck",
      actual: { status: res.status, a: own.status },
      allowed: res.status === 200 && own.status === "failed",
    });
    record.attack("Failing A's stuck deployment reaching B's running one", {
      expected: "B's row byte-for-byte unchanged",
      actual: { before, after },
      refused: JSON.stringify(after) === JSON.stringify(before),
    });
    expect(res.status).toBe(200);
    expect(own.status).toBe("failed");
    expect(after).toEqual(before);
  });

  it("abandoning A's pending upload removes only A's", async () => {
    const before = await stateOf(TENANT_B);
    const res = await outcome(() => abandonUpload(PENDING_A));
    const own = await stateOf(TENANT_A);
    const after = await stateOf(TENANT_B);
    record.control("Alice abandons her own pending upload", {
      expected: "A's pending row removed, A's uploaded document kept",
      actual: { result: res.ok, documents: own.documents.map((d) => d.id) },
      allowed: res.ok && own.documents.map((d) => d.id).join() === DOC_A,
    });
    record.attack("Abandoning A's upload reaching B's pending upload", {
      expected: "B's documents unchanged",
      actual: { before: before.documents, after: after.documents },
      refused: JSON.stringify(after) === JSON.stringify(before),
    });
    expect(res.ok).toBe(true);
    expect(own.documents.map((d) => d.id)).toEqual([DOC_A]);
    expect(after).toEqual(before);
  });

  it("Alice can neither overwrite nor delete Bob's wizard draft", async () => {
    const [bobs] = await db.insert(tenantDrafts).values({ ownerUserId: BOB, name: "beta-draft", data: { name: "beta-draft" }, step: 2 }).returning();
    const draft = async (id: string) =>
      (await h.client!.query<{ owner_user_id: string; name: string | null; step: number; data: unknown }>(
        "SELECT owner_user_id, name, step, data FROM tenant_drafts WHERE id = $1",
        [id],
      )).rows[0];
    const before = await draft(bobs.id);
    const saved = await saveTenantDraft(null, buildFormData({ draftId: bobs.id, name: "hijacked", step: "4" }));
    await deleteTenantDraft(bobs.id);
    const after = await draft(bobs.id);
    const aliceDraft = saved && "draftId" in saved ? saved.draftId : undefined;
    const mine = aliceDraft ? await draft(aliceDraft) : undefined;
    record.attack("Alice saves over, then deletes, Bob's draft by its ID", {
      expected: "Bob's draft byte-for-byte unchanged",
      actual: { before, after, savedTo: aliceDraft === bobs.id ? "Bob's draft" : "a new draft" },
      refused: JSON.stringify(after) === JSON.stringify(before) && aliceDraft !== bobs.id,
    });
    record.control("Alice's save lands in a draft of her own, which she can delete", {
      expected: "a new draft owned by Alice, removed by her delete",
      actual: { owner: mine?.owner_user_id ?? null },
      allowed: mine?.owner_user_id === ALICE,
    });
    expect(after).toEqual(before);
    expect(aliceDraft).toBeDefined();
    expect(aliceDraft).not.toBe(bobs.id);
    expect(mine?.owner_user_id).toBe(ALICE);
    await deleteTenantDraft(aliceDraft!);
    expect(await draft(aliceDraft!)).toBeUndefined();
  });
});
