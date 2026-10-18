/**
 * Security test S10: one operator cannot reach another operator's tenants
 * through the control plane (docs/evaluation/security).
 *
 * Tenants belong to the operator who created them (tenants.owner_user_id),
 * and every action that names a tenant, deployment or document has to check
 * that. Unlike the per-module tests, these run the real SQL each action sends
 * against a fake database holding two operators' tenants (see
 * src/test/fake-db.ts), so they fail if an ownership condition is missing
 * from a query, not only if the code forgets to look at the result.
 *
 * Every refusal is paired with the same call on the operator's own tenant,
 * so a pass cannot come from an action that refuses everyone.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { buildFormData } from "@/test/form-data";

const h = vi.hoisted(() => {
  const alice = "user-alice";
  const bob = "user-bob";
  const tenantA = "a0000000-0000-4000-8000-00000000000a";
  const tenantB = "b0000000-0000-4000-8000-00000000000b";
  const tenant = (id: string, owner: string, slug: string) => ({
    id,
    name: slug,
    slug,
    owner_user_id: owner,
    cloud_provider: "aws",
    aws_account_id: "111122223333",
    aws_region: "eu-central-1",
    deployment_role_arn: `arn:aws:iam::111122223333:role/chatbot-client-deploy-${slug}`,
    docs_signer_url: `https://${slug}.lambda-url.eu-central-1.on.aws/`,
    chatbot_version: "latest",
    deleted_at: null,
  });
  const deployment = (id: string, tenantId: string) => ({
    id,
    tenant_id: tenantId,
    kind: "deploy",
    status: "succeeded",
    chatbot_version: "latest",
    started_at: "2026-10-01T10:00:00.000Z",
    finished_at: "2026-10-01T10:12:00.000Z",
  });
  const document = (id: string, tenantId: string) => ({
    id,
    tenant_id: tenantId,
    object_key: `${id}.pdf`,
    display_name: `${id}.pdf`,
    content_type: "application/pdf",
    size_bytes: 1024,
    status: "uploaded",
  });
  return {
    alice,
    bob,
    tenantA,
    tenantB,
    tables: {
      tenants: [tenant(tenantA, alice, "alpha"), tenant(tenantB, bob, "beta")],
      deployments: [
        deployment("da000000-0000-4000-8000-0000000000da", tenantA),
        deployment("db000000-0000-4000-8000-0000000000db", tenantB),
      ],
      tenant_documents: [
        document("ca000000-0000-4000-8000-0000000000ca", tenantA),
        document("cb000000-0000-4000-8000-0000000000cb", tenantB),
      ],
    },
    session: null as { user: { id: string } } | null,
    fake: null as null | { writes: string[] },
    triggerDeployment: vi.fn(),
    triggerTenantDestroy: vi.fn(),
    presignUpload: vi.fn(),
    deleteViaSigner: vi.fn(),
    triggerReindex: vi.fn(),
    startConnectionCheck: vi.fn(),
  };
});

vi.mock("@/auth", () => ({ auth: vi.fn(async () => h.session) }));
vi.mock("@/db", async () => {
  const { fakeDb } = await import("@/test/fake-db");
  const fake = fakeDb(h.tables);
  h.fake = fake;
  return { db: fake.db };
});
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((to: string) => {
    throw new Error(`NEXT_REDIRECT ${to}`);
  }),
}));
vi.mock("@/lib/deploy", () => ({
  triggerDeployment: h.triggerDeployment,
  triggerTenantDestroy: h.triggerTenantDestroy,
  AZURE_DEPLOY_WORKFLOW: "deploy-tenant-azure.yml",
  AZURE_DESTROY_WORKFLOW: "destroy-tenant-azure.yml",
}));
vi.mock("@/lib/docsSigner", () => ({
  presignUpload: h.presignUpload,
  deleteViaSigner: h.deleteViaSigner,
  DocsSignerError: class DocsSignerError extends Error {},
}));
vi.mock("@/lib/reindex", () => ({ triggerReindex: h.triggerReindex }));
vi.mock("@/lib/github", () => ({
  fetchRunProgress: vi.fn(),
  findRunForDeployment: vi.fn(),
  getDeployWorkflowId: () => "deploy-tenant.yml",
  getDestroyWorkflowId: () => "destroy-tenant.yml",
}));
vi.mock("@/lib/reconcile", () => ({ ACTIVE_STATUSES: ["pending", "running"], reconcileCompletedRun: vi.fn() }));
vi.mock("@/lib/verifyConnection", () => ({
  startConnectionCheck: h.startConnectionCheck,
  pollConnectionCheck: vi.fn(),
}));

import { GET as deploymentProgress } from "@/app/api/deployments/[id]/progress/route";
import { deleteTenant, redeployTenant } from "@/app/tenants/[id]/actions";
import { abandonUpload, confirmUpload, deleteDocument, requestUploadUrl } from "@/app/tenants/[id]/documents/actions";
import { startCheck } from "@/app/tenants/connectionActions";

const [deploymentA, deploymentB] = h.tables.deployments.map((d) => d.id);
const [documentA, documentB] = h.tables.tenant_documents.map((d) => d.id);
const signedInAs = (user: string | null) => {
  h.session = user ? { user: { id: user } } : null;
};
const progress = (id: string) => deploymentProgress(new Request(`http://platform/api/deployments/${id}/progress`), { params: Promise.resolve({ id }) });
const tenantForm = (tenantId: string) => buildFormData({ tenantId });
const checkForm = (tenantId: string, slug: string) =>
  buildFormData({
    cloudProvider: "aws",
    tenantId,
    slug,
    awsRegion: "eu-central-1",
    deploymentRoleArn: `arn:aws:iam::111122223333:role/chatbot-client-deploy-${slug}`,
  });

/** Nothing reached a customer's cloud, GitHub, or the database. */
function expectNoSideEffects() {
  expect(h.triggerDeployment).not.toHaveBeenCalled();
  expect(h.triggerTenantDestroy).not.toHaveBeenCalled();
  expect(h.presignUpload).not.toHaveBeenCalled();
  expect(h.deleteViaSigner).not.toHaveBeenCalled();
  expect(h.triggerReindex).not.toHaveBeenCalled();
  expect(h.startConnectionCheck).not.toHaveBeenCalled();
  expect(h.fake?.writes).toEqual([]);
}

beforeEach(() => {
  vi.clearAllMocks();
  h.fake?.writes.splice(0);
  h.presignUpload.mockRejectedValue(new Error("presign stopped here by the test"));
  h.triggerReindex.mockResolvedValue({ ok: true });
  h.startConnectionCheck.mockResolvedValue({ startedAt: new Date("2026-10-11T00:00:00Z") });
  signedInAs(h.alice);
});

describe("S10.1 — without a session, nothing is reachable", () => {
  beforeEach(() => signedInAs(null));

  it("S10.1 the deployment API answers 401", async () => {
    expect((await progress(deploymentA)).status).toBe(401);
  });

  it("S10.1 every tenant action refuses before acting", async () => {
    await expect(redeployTenant(tenantForm(h.tenantA))).rejects.toThrow("Not authenticated");
    await expect(deleteTenant(tenantForm(h.tenantA))).rejects.toThrow("Not authenticated");
    expect(await requestUploadUrl(h.tenantA, "x.pdf", "application/pdf", 10)).toMatchObject({ ok: false });
    await expect(deleteDocument(documentA)).rejects.toThrow("Not authenticated");
    await expect(confirmUpload(documentA)).rejects.toThrow("Not authenticated");
    await expect(startCheck(null, checkForm(h.tenantA, "alpha"))).rejects.toThrow("NEXT_REDIRECT /signin");
    expectNoSideEffects();
  });
});

describe("S10.2 — another operator's deployment", () => {
  it("S10.2 is answered 404, as if it did not exist", async () => {
    const response = await progress(deploymentB);
    expect(response.status).toBe(404);
    expect(JSON.stringify(await response.json())).not.toContain(h.tenantB);
  });

  it("S10.2 control: the operator's own deployment is returned", async () => {
    const response = await progress(deploymentA);
    expect(response.status).toBe(200);
    expect(JSON.stringify(await response.json())).toContain(deploymentA);
  });
});

describe("S10.3 — destroying another operator's tenant", () => {
  it("S10.3 is refused, and no teardown is dispatched", async () => {
    await expect(deleteTenant(tenantForm(h.tenantB))).rejects.toThrow("Tenant not found");
    expectNoSideEffects();
  });

  it("S10.3 control: the operator's own tenant is torn down", async () => {
    await deleteTenant(tenantForm(h.tenantA));
    expect(h.triggerTenantDestroy).toHaveBeenCalledWith(expect.objectContaining({ tenantId: h.tenantA }));
  });
});

describe("S10.4 — upload authorization for another operator's tenant", () => {
  it("S10.4 is refused before the tenant's signer is asked", async () => {
    expect(await requestUploadUrl(h.tenantB, "x.pdf", "application/pdf", 10)).toEqual({
      ok: false,
      error: "Tenant not found.",
    });
    expectNoSideEffects();
  });

  it("S10.4 control: the operator's own tenant reaches its signer", async () => {
    await requestUploadUrl(h.tenantA, "x.pdf", "application/pdf", 10);
    expect(h.presignUpload).toHaveBeenCalledWith(expect.objectContaining({ id: h.tenantA }), expect.anything());
  });
});

describe("S10.5 — another operator's ID put into a request", () => {
  it("S10.5 a redeploy naming another tenant is refused", async () => {
    await expect(redeployTenant(tenantForm(h.tenantB))).rejects.toThrow("Tenant not found");
    expectNoSideEffects();
  });

  it("S10.5 document actions naming another tenant's document are refused", async () => {
    await expect(deleteDocument(documentB)).rejects.toThrow("Tenant not found");
    await expect(confirmUpload(documentB)).rejects.toThrow("Tenant not found");
    await expect(abandonUpload(documentB)).rejects.toThrow("Tenant not found");
    expectNoSideEffects();
  });

  it("S10.5 control: the operator's own document is deleted through its own tenant's signer", async () => {
    await deleteDocument(documentA);
    expect(h.deleteViaSigner).toHaveBeenCalledWith(expect.objectContaining({ id: h.tenantA }), `${documentA}.pdf`);
  });

  // A connection check runs in the tenant's GitHub environment, so the
  // customer's cloud accepts its sign-in. Tenant IDs appear in the public
  // repository's Actions runs, so the ID alone must not be enough.
  it("S10.5 a connection check naming another operator's tenant is refused", async () => {
    const result = await startCheck(null, checkForm(h.tenantB, "beta"));
    expect(result).toMatchObject({ error: expect.any(String) });
    expectNoSideEffects();
  });

  it("S10.5 control: checks for the operator's own tenant and for a new chatbot still run", async () => {
    await startCheck(null, checkForm(h.tenantA, "alpha"));
    await startCheck(null, checkForm("c0000000-0000-4000-8000-0000000000c0", "gamma"));
    expect(h.startConnectionCheck).toHaveBeenCalledTimes(2);
  });
});
