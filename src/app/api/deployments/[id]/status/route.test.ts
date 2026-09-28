import { describe, it, expect, beforeEach, vi } from "vitest";
import { selectJoinChain, updateSetWhereChain, thenableWithReturning } from "@/test/db-chains";

// Only the leaf mocks need to be shared with the test bodies, so only they go
// through vi.hoisted. `db.update` itself is built fresh inside the vi.mock
// factory (mirroring deploy.test.ts) — that's the only point guaranteed to run
// after this file's own `@/test/db-chains` import has resolved, since
// vi.hoisted() callbacks run before any of this file's imports do.
const { dbUpdateReturning, dbSelectWhere } = vi.hoisted(() => ({
  dbUpdateReturning: vi.fn(),
  dbSelectWhere: vi.fn(),
}));

vi.mock("@/db", () => ({
  db: {
    select: vi.fn(() => selectJoinChain(dbSelectWhere)),
    update: vi.fn(() =>
      updateSetWhereChain(vi.fn(() => thenableWithReturning(dbUpdateReturning))),
    ),
  },
}));

const awsTenant = {
  id: "tenant-1",
  slug: "acme",
  cloudProvider: "aws",
  awsRegion: "us-east-1",
  docsSignerUrl: null as string | null,
};
const azureTenant = { ...awsTenant, cloudProvider: "azure", awsRegion: null };
const runningDeployment = { id: "dep-1", tenantId: "tenant-1", kind: "deploy", status: "running" };

function lookupReturns(
  deployment: Record<string, unknown> = runningDeployment,
  tenant: Record<string, unknown> = awsTenant,
) {
  dbSelectWhere.mockResolvedValue([{ deployment, tenant }]);
}

import { db } from "@/db";
import { deployments, tenants } from "@/db/schema";
import { POST } from "./route";

const SECRET = "s3cr3t-webhook-value";

function makeRequest(opts: { headers?: Record<string, string>; body?: unknown; rawBody?: string }) {
  const headers = new Headers(opts.headers ?? { "x-webhook-secret": SECRET });
  const body = "rawBody" in opts && opts.rawBody !== undefined ? opts.rawBody : JSON.stringify(opts.body ?? {});
  return new Request("http://localhost/api/deployments/dep-1/status", {
    method: "POST",
    headers,
    body,
  });
}

function callRoute(opts: Parameters<typeof makeRequest>[0]) {
  return POST(makeRequest(opts), { params: Promise.resolve({ id: "dep-1" }) });
}

/** Each db.update() call gets its own fresh `.set` mock (see updateSetWhereChain);
 *  this reads back the arguments a specific call (0-indexed) passed to `.set()`. */
function setArgsForUpdateCall(callIndex: number) {
  return db.update.mock.results[callIndex].value.set.mock.calls[0][0];
}

describe("POST /api/deployments/[id]/status", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.DEPLOY_WEBHOOK_SECRET = SECRET;
    lookupReturns();
    dbUpdateReturning.mockResolvedValue([{ id: "dep-1", tenantId: "tenant-1" }]);
  });

  describe("authorization", () => {
    it("rejects when DEPLOY_WEBHOOK_SECRET is not configured, even with a matching header", async () => {
      delete process.env.DEPLOY_WEBHOOK_SECRET;

      const res = await callRoute({ headers: { "x-webhook-secret": SECRET }, body: { status: "running" } });

      expect(res.status).toBe(401);
      expect(db.update).not.toHaveBeenCalled();
    });

    it("rejects when the header is missing", async () => {
      const res = await callRoute({ headers: {}, body: { status: "running" } });
      expect(res.status).toBe(401);
    });

    it("rejects when the header value is wrong", async () => {
      const res = await callRoute({
        headers: { "x-webhook-secret": "wrong-value-wrong-value" },
        body: { status: "running" },
      });
      expect(res.status).toBe(401);
    });

    it("rejects when the header is a different length than the secret", async () => {
      const res = await callRoute({ headers: { "x-webhook-secret": "short" }, body: { status: "running" } });
      expect(res.status).toBe(401);
    });

    it("accepts a header that exactly matches the configured secret", async () => {
      const res = await callRoute({ headers: { "x-webhook-secret": SECRET }, body: { status: "running" } });
      expect(res.status).toBe(200);
    });
  });

  describe("body validation", () => {
    it("rejects malformed JSON with 400", async () => {
      const res = await callRoute({ rawBody: "{not json" });
      expect(res.status).toBe(400);
      expect(db.update).not.toHaveBeenCalled();
    });

    it("rejects an unrecognized status enum value with 400", async () => {
      const res = await callRoute({ body: { status: "in-progress" } });
      expect(res.status).toBe(400);
    });

    it("rejects a githubRunUrl that is not a valid URL", async () => {
      const res = await callRoute({ body: { status: "running", githubRunUrl: "not-a-url" } });
      expect(res.status).toBe(400);
    });
  });

  describe("deployment update", () => {
    it("returns 404 when the deployment row does not exist", async () => {
      dbSelectWhere.mockResolvedValue([]);

      const res = await callRoute({ body: { status: "running" } });

      expect(res.status).toBe(404);
      expect(db.update).not.toHaveBeenCalled();
    });

    it("does not set finishedAt for a non-terminal status", async () => {
      const res = await callRoute({ body: { status: "running" } });

      expect(res.status).toBe(200);
      expect(db.update).toHaveBeenCalledTimes(1);
      expect(setArgsForUpdateCall(0)).not.toHaveProperty("finishedAt");
    });

    it.each(["succeeded", "failed", "cancelled"] as const)(
      "sets finishedAt for the terminal status '%s'",
      async (status) => {
        const res = await callRoute({ body: { status } });

        expect(res.status).toBe(200);
        expect(setArgsForUpdateCall(0)).toHaveProperty("finishedAt");
        expect(setArgsForUpdateCall(0).finishedAt).toBeInstanceOf(Date);
      },
    );

    it("targets the deployments table for the first update", async () => {
      await callRoute({ body: { status: "running" } });
      expect(db.update.mock.calls[0][0]).toBe(deployments);
    });
  });

  // A deployment only moves forward. A late or retried callback must not
  // reopen or rewrite one that has finished.
  describe("status transitions", () => {
    it.each(["succeeded", "failed", "cancelled"])(
      "refuses any update to a deployment that is already %s",
      async (finished) => {
        lookupReturns({ ...runningDeployment, status: finished });

        const res = await callRoute({ body: { status: "running" } });

        expect(res.status).toBe(409);
        expect(db.update).not.toHaveBeenCalled();
      },
    );

    it("never lets a run move a deployment back to pending", async () => {
      const res = await callRoute({ body: { status: "pending" } });

      expect(res.status).toBe(400);
      expect(db.update).not.toHaveBeenCalled();
    });

    it("accepts running → succeeded", async () => {
      const res = await callRoute({ body: { status: "succeeded" } });
      expect(res.status).toBe(200);
    });

    it("accepts a pending deployment's first callback", async () => {
      lookupReturns({ ...runningDeployment, status: "pending" });
      const res = await callRoute({ body: { status: "running" } });
      expect(res.status).toBe(200);
    });

    // The guarded write matched nothing: a reconcile or another callback
    // finished the deployment after it was read.
    it("reports a concurrent finish instead of overwriting it", async () => {
      dbUpdateReturning.mockResolvedValue([]);

      const res = await callRoute({ body: { status: "failed" } });

      expect(res.status).toBe(409);
      expect(db.update).toHaveBeenCalledTimes(1);
    });
  });

  // The platform sends the tenant's docs-signer secret to this URL, so an
  // unchecked value would hand the secret to whoever chose it.
  describe("docsSignerUrl", () => {
    it.each([
      ["another host", "https://attacker.example/collect"],
      ["another region", "https://abc123.lambda-url.eu-west-1.on.aws/"],
      ["plain http", "http://abc123.lambda-url.us-east-1.on.aws/"],
      ["a lookalike suffix", "https://abc123.lambda-url.us-east-1.on.aws.attacker.example/"],
      ["a query string", "https://abc123.lambda-url.us-east-1.on.aws/?x=1"],
    ])("refuses %s for an AWS tenant, before writing anything", async (_label, url) => {
      const res = await callRoute({ body: { status: "succeeded", docsSignerUrl: url } });

      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/docsSignerUrl refused/);
      expect(db.update).not.toHaveBeenCalled();
    });

    it("accepts exactly the Azure Function this tenant's Terraform names", async () => {
      lookupReturns(runningDeployment, azureTenant);

      const res = await callRoute({
        body: {
          status: "succeeded",
          docsSignerUrl: "https://chatbot-acme-docs-signer.azurewebsites.net/api/docs-signer",
        },
      });

      expect(res.status).toBe(200);
    });

    it("refuses another tenant's Azure Function", async () => {
      lookupReturns(runningDeployment, azureTenant);

      const res = await callRoute({
        body: {
          status: "succeeded",
          docsSignerUrl: "https://chatbot-other-docs-signer.azurewebsites.net/api/docs-signer",
        },
      });

      expect(res.status).toBe(400);
    });

    // On AWS the shape cannot tell the tenant's Lambda from anyone else's in
    // the same region, so the first URL recorded is pinned.
    it("refuses to replace a docs-signer URL already on record", async () => {
      lookupReturns(runningDeployment, {
        ...awsTenant,
        docsSignerUrl: "https://original.lambda-url.us-east-1.on.aws/",
      });

      const res = await callRoute({
        body: { status: "succeeded", docsSignerUrl: "https://attackers.lambda-url.us-east-1.on.aws/" },
      });

      expect(res.status).toBe(400);
      expect(db.update).not.toHaveBeenCalled();
    });

    it("accepts the same URL again on a redeploy", async () => {
      const url = "https://original.lambda-url.us-east-1.on.aws/";
      lookupReturns(runningDeployment, { ...awsTenant, docsSignerUrl: url });

      const res = await callRoute({ body: { status: "succeeded", docsSignerUrl: url } });

      expect(res.status).toBe(200);
    });
  });

  describe("tenant URL propagation", () => {
    it("updates the tenant row when status is succeeded and chatbotUrl is provided", async () => {
      const res = await callRoute({
        body: { status: "succeeded", chatbotUrl: "https://chat.acme.com" },
      });

      expect(res.status).toBe(200);
      expect(db.update).toHaveBeenCalledTimes(2);
      expect(db.update.mock.calls[1][0]).toBe(tenants);
      expect(setArgsForUpdateCall(1)).toMatchObject({ chatbotUrl: "https://chat.acme.com" });
    });

    it("updates the tenant row when status is succeeded and albDnsName is provided", async () => {
      await callRoute({
        body: { status: "succeeded", albDnsName: "alb-123.us-east-1.elb.amazonaws.com" },
      });

      expect(db.update).toHaveBeenCalledTimes(2);
      expect(setArgsForUpdateCall(1)).toMatchObject({
        albDnsName: "alb-123.us-east-1.elb.amazonaws.com",
      });
    });

    it("updates the tenant row when status is succeeded and docsSignerUrl is provided", async () => {
      await callRoute({
        body: { status: "succeeded", docsSignerUrl: "https://abc123.lambda-url.us-east-1.on.aws/" },
      });

      expect(db.update).toHaveBeenCalledTimes(2);
      expect(setArgsForUpdateCall(1)).toMatchObject({
        docsSignerUrl: "https://abc123.lambda-url.us-east-1.on.aws/",
      });
    });

    it("updates the tenant row when status is succeeded and Azure infra names are provided", async () => {
      await callRoute({
        body: {
          status: "succeeded",
          azureResourceGroup: "chatbot-acme",
          azureStorageAccount: "chatbotacme",
          azureStorageContainer: "documents",
          azureKeyVaultName: "cb-acme-kv",
        },
      });

      expect(db.update).toHaveBeenCalledTimes(2);
      expect(setArgsForUpdateCall(1)).toMatchObject({
        azureResourceGroup: "chatbot-acme",
        azureStorageAccount: "chatbotacme",
        azureStorageContainer: "documents",
        azureKeyVaultName: "cb-acme-kv",
      });
    });

    it("sets tenants.deletedAt (not URL fields) when a destroy deployment succeeds", async () => {
      dbUpdateReturning.mockResolvedValue([{ id: "dep-1", tenantId: "tenant-1", kind: "destroy" }]);

      await callRoute({ body: { status: "succeeded" } });

      expect(db.update).toHaveBeenCalledTimes(2);
      expect(db.update.mock.calls[1][0]).toBe(tenants);
      expect(setArgsForUpdateCall(1)).toMatchObject({ deletedAt: expect.any(Date) });
      expect(setArgsForUpdateCall(1)).not.toHaveProperty("chatbotUrl");
    });

    // Nothing can use them once the infrastructure is gone, so keeping them
    // would only be risk (see tenantErasure.ts).
    it("erases the tenant's stored secrets when a destroy succeeds", async () => {
      dbUpdateReturning.mockResolvedValue([{ id: "dep-1", tenantId: "tenant-1", kind: "destroy" }]);

      await callRoute({ body: { status: "succeeded" } });

      expect(setArgsForUpdateCall(1)).toMatchObject({
        llmApiKeyEncrypted: null,
        pineconeApiKeyEncrypted: null,
        docsSignerSecretEncrypted: null,
        docsSignerUrl: null,
      });
    });

    it("never erases secrets on a successful deploy", async () => {
      dbUpdateReturning.mockResolvedValue([{ id: "dep-1", tenantId: "tenant-1", kind: "deploy" }]);

      await callRoute({ body: { status: "succeeded", chatbotUrl: "https://chat.acme.com" } });

      expect(setArgsForUpdateCall(1)).not.toHaveProperty("llmApiKeyEncrypted");
      expect(setArgsForUpdateCall(1)).not.toHaveProperty("deletedAt");
    });

    // Also the retry guarantee: the Azure teardown needs the Pinecone key to
    // delete the index, so a failed one must leave every secret in place.
    it("does not touch tenants for a destroy deployment that failed", async () => {
      dbUpdateReturning.mockResolvedValue([{ id: "dep-1", tenantId: "tenant-1", kind: "destroy" }]);

      await callRoute({ body: { status: "failed", errorMessage: "boom" } });

      expect(db.update).toHaveBeenCalledTimes(1);
    });

    it("does not update the tenant row when status is succeeded but no URL fields are provided", async () => {
      await callRoute({ body: { status: "succeeded" } });
      expect(db.update).toHaveBeenCalledTimes(1);
    });

    it("does not update the tenant row for a non-succeeded terminal status even with URL fields", async () => {
      await callRoute({
        body: { status: "failed", chatbotUrl: "https://chat.acme.com", errorMessage: "boom" },
      });
      expect(db.update).toHaveBeenCalledTimes(1);
    });
  });
});
