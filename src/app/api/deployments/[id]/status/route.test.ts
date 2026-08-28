import { describe, it, expect, beforeEach, vi } from "vitest";
import { updateSetWhereChain, thenableWithReturning } from "@/test/db-chains";

// Only the leaf `returning` mock needs to be shared with the test bodies, so
// only it goes through vi.hoisted. `db.update` itself is built fresh inside
// the vi.mock factory (mirroring deploy.test.ts) — that's the only point
// guaranteed to run after this file's own `@/test/db-chains` import has
// resolved, since vi.hoisted() callbacks run before any of this file's
// imports do.
const { dbUpdateReturning } = vi.hoisted(() => ({ dbUpdateReturning: vi.fn() }));

vi.mock("@/db", () => ({
  db: {
    update: vi.fn(() =>
      updateSetWhereChain(vi.fn(() => thenableWithReturning(dbUpdateReturning))),
    ),
  },
}));

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
      dbUpdateReturning.mockResolvedValue([]);

      const res = await callRoute({ body: { status: "running" } });

      expect(res.status).toBe(404);
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
