import { describe, it, expect, beforeEach, vi } from "vitest";

const { releaseDeploymentSecrets } = vi.hoisted(() => ({ releaseDeploymentSecrets: vi.fn() }));

// Keep the real SecretsRequestError so the route's instanceof check is the one
// it runs in production; only the token verification is replaced.
vi.mock("@/lib/deploymentSecrets", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/deploymentSecrets")>()),
  releaseDeploymentSecrets,
}));

import { SecretsRequestError } from "@/lib/deploymentSecrets";
import { POST } from "./route";

function call(headers: Record<string, string> = { authorization: "Bearer oidc-token" }) {
  const req = new Request("http://localhost/api/deployments/dep-1/secrets", { method: "POST", headers });
  return POST(req, { params: Promise.resolve({ id: "dep-1" }) });
}

describe("POST /api/deployments/[id]/secrets", () => {
  beforeEach(() => {
    releaseDeploymentSecrets.mockReset();
  });

  it("rejects a request with no bearer token, without checking anything", async () => {
    const res = await call({});

    expect(res.status).toBe(401);
    expect(releaseDeploymentSecrets).not.toHaveBeenCalled();
  });

  it("rejects an authorization header that is not a bearer token", async () => {
    const res = await call({ authorization: "Basic dXNlcjpwYXNz" });

    expect(res.status).toBe(401);
    expect(releaseDeploymentSecrets).not.toHaveBeenCalled();
  });

  it("returns the released secrets, uncached, for a token that proves the run", async () => {
    releaseDeploymentSecrets.mockResolvedValue({ PINECONE_API_KEY: "pk" });

    const res = await call({ authorization: "bearer oidc-token" });

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ PINECONE_API_KEY: "pk" });
    expect(releaseDeploymentSecrets).toHaveBeenCalledWith("dep-1", "oidc-token");
  });

  it("answers with the refusal's own status and message", async () => {
    releaseDeploymentSecrets.mockRejectedValue(
      new SecretsRequestError(403, "The token was not issued to the platform's deploy repository."),
    );

    const res = await call();

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "The token was not issued to the platform's deploy repository." });
  });

  it("lets an unexpected error propagate rather than disguising it as a refusal", async () => {
    releaseDeploymentSecrets.mockRejectedValue(new Error("database unreachable"));

    await expect(call()).rejects.toThrow("database unreachable");
  });
});
