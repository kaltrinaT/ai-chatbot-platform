import { describe, it, expect } from "vitest";
import { firstTakenGlobalName, type Probes } from "./nameAvailability";

const notFound = () => Promise.reject(Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" }));

function probes(overrides: Partial<Probes>): Probes {
  return { resolve: notFound, s3Status: async () => 404, ...overrides };
}

describe("firstTakenGlobalName — Azure", () => {
  it("names the resource whose hostname already exists", async () => {
    const taken = await firstTakenGlobalName(
      "azure",
      "acme",
      probes({ resolve: (host) => (host === "cb-acme-kv.vault.azure.net" ? Promise.resolve({}) : notFound()) }),
    );
    expect(taken).toMatchObject({ resource: "key vault", name: "cb-acme-kv" });
  });

  // The customer's setup creates the state storage account before the
  // chatbot is submitted. Counting it would refuse every onboarding at the
  // last step, over a resource the customer had just been asked to create.
  it("does not count the state storage account the customer's own setup created", async () => {
    const taken = await firstTakenGlobalName(
      "azure",
      "product-chatbot99",
      probes({ resolve: (host) => (host === "cbtfproductchatbot99.blob.core.windows.net" ? Promise.resolve({}) : notFound()) }),
    );
    expect(taken).toBeNull();
  });

  it("finds nothing when every hostname is unknown", async () => {
    await expect(firstTakenGlobalName("azure", "acme", probes({}))).resolves.toBeNull();
  });

  // A resolver that fails in any other way has not answered, and a flaky
  // resolver must never block a slug that is fine.
  it("reads an error that is not 'not found' as free", async () => {
    const taken = await firstTakenGlobalName("azure", "acme", probes({ resolve: () => Promise.reject(new Error("ECONNREFUSED")) }));
    expect(taken).toBeNull();
  });
});

describe("firstTakenGlobalName — AWS", () => {
  it("reads S3's 404 as a free bucket", async () => {
    await expect(firstTakenGlobalName("aws", "acme", probes({ s3Status: async () => 404 }))).resolves.toBeNull();
  });

  // 403 is a bucket that exists in someone else's account.
  it("reads any other answer as a bucket someone holds", async () => {
    const taken = await firstTakenGlobalName("aws", "acme", probes({ s3Status: async () => 403 }));
    expect(taken).toMatchObject({ resource: "documents bucket", name: "chatbot-acme-docs" });
  });

  it("reads a request that failed as free", async () => {
    const taken = await firstTakenGlobalName("aws", "acme", probes({ s3Status: () => Promise.reject(new Error("timeout")) }));
    expect(taken).toBeNull();
  });
});
