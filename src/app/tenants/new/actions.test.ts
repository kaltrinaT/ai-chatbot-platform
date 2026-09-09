import { describe, it, expect, beforeEach, vi } from "vitest";
import { buildFormData } from "@/test/form-data";

const {
  authMock,
  dbInsertValues,
  dbInsertReturning,
  dbUpdateValues,
  dbUpdateReturning,
  triggerDeployment,
  encryptSecret,
  assumeTenantRole,
  writeTenantSecret,
  ensureDocsSignerSecret,
  generateDocsSignerSecret,
  redirectMock,
} = vi.hoisted(() => {
    const authMock = vi.fn();
    const dbInsertReturning = vi.fn();
    // Declared here (rather than via insertValuesReturningChain) so tests can
    // assert on the row actually handed to drizzle, not just that it inserted.
    // The signature is supplied as a type argument so `mock.calls` is typed
    // without the implementation needing an unused parameter.
    const dbInsertValues = vi.fn<(row: unknown) => { returning: typeof dbInsertReturning }>(
      () => ({ returning: dbInsertReturning }),
    );
    const dbUpdateReturning = vi.fn();
    // Same rationale as dbInsertValues: kept as a stable mock (not a fresh
    // chain per call) so saveTenantDraft's update-path tests can inspect the
    // row it actually passed to drizzle, e.g. confirming secret fields never
    // reach `.set(...)`.
    const dbUpdateValues = vi.fn<
      (row: unknown) => { where: () => { returning: typeof dbUpdateReturning } }
    >(() => ({ where: () => ({ returning: dbUpdateReturning }) }));
    const triggerDeployment = vi.fn();
    const encryptSecret = vi.fn((v: string) => `enc:${v}`);
    const assumeTenantRole = vi.fn();
    const writeTenantSecret = vi.fn();
    const ensureDocsSignerSecret = vi.fn();
    const generateDocsSignerSecret = vi.fn();
    const redirectMock = vi.fn((url: string) => {
      throw new Error(`REDIRECT:${url}`);
    });
    return {
      authMock,
      dbInsertValues,
      dbInsertReturning,
      dbUpdateValues,
      dbUpdateReturning,
      triggerDeployment,
      encryptSecret,
      assumeTenantRole,
      writeTenantSecret,
      ensureDocsSignerSecret,
      generateDocsSignerSecret,
      redirectMock,
    };
  });

vi.mock("next/navigation", () => ({ redirect: redirectMock }));
vi.mock("@/auth", () => ({ auth: authMock }));
vi.mock("@/db", () => ({
  db: {
    insert: vi.fn(() => ({ values: dbInsertValues })),
    update: vi.fn(() => ({ set: dbUpdateValues })),
    // Only reached when the wizard submits a draftId; stubbed so the
    // post-deploy draft cleanup doesn't blow up the success-path tests.
    delete: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })),
  },
}));
vi.mock("@/lib/deploy", () => ({ triggerDeployment }));
vi.mock("@/lib/crypto", () => ({ encryptSecret }));
vi.mock("@/lib/aws", () => ({ assumeTenantRole, writeTenantSecret, ensureDocsSignerSecret }));
vi.mock("@/lib/azure", () => ({ generateDocsSignerSecret }));

import { db } from "@/db";
import { tenantDrafts } from "@/db/schema";
import { createTenantAndDeploy, saveTenantDraft, deleteTenantDraft } from "./actions";

function formData(fields: Record<string, string | undefined>): FormData {
  return buildFormData(fields);
}

/** The row handed to `db.insert(tenants).values(...)` by the last call. */
function insertedValues(): Record<string, unknown> {
  const calls = dbInsertValues.mock.calls;
  return calls[calls.length - 1][0] as Record<string, unknown>;
}

/** The row handed to `db.update(tenantDrafts).set(...)` by the last call. */
function updatedValues(): Record<string, unknown> {
  const calls = dbUpdateValues.mock.calls;
  return calls[calls.length - 1][0] as Record<string, unknown>;
}

const validAws = {
  cloudProvider: "aws",
  name: "Acme Co",
  slug: "acme-co",
  chatbotVersion: "latest",
  domain: "chat.acme.com",
  llmProvider: "openai",
  llmApiKey: "sk-1234567890",
  llmModel: "gpt-4o",
  vectorStore: "pinecone",
  pineconeApiKey: "pc-1234567890",
  awsAccountId: "123456789012",
  awsRegion: "us-east-1",
  deploymentRoleArn: "arn:aws:iam::123456789012:role/deploy",
  s3DocsPrefix: "docs/",
};

const validAzure = {
  cloudProvider: "azure",
  name: "Beta Co",
  slug: "beta-co",
  chatbotVersion: "latest",
  domain: "chat.beta.com",
  llmProvider: "anthropic",
  llmApiKey: "sk-ant-1234567890",
  llmModel: "claude-sonnet",
  vectorStore: "pgvector",
  azureSubscriptionId: "12345678-1234-1234-1234-123456789012",
  azureTenantId: "22222222-2222-2222-2222-222222222222",
  azureClientId: "33333333-3333-3333-3333-333333333333",
  azureClientSecret: "az-secret-1",
  azureRegion: "eastus",
};

describe("createTenantAndDeploy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authMock.mockResolvedValue({ user: { id: "user-1" } });
    dbInsertReturning.mockResolvedValue([{ id: "tenant-1" }]);
    triggerDeployment.mockResolvedValue({
      id: "deploy-1",
      startedAt: new Date("2026-01-01T00:00:00Z"),
    });
    encryptSecret.mockImplementation((v: string) => `enc:${v}`);
    assumeTenantRole.mockResolvedValue({
      accessKeyId: "a",
      secretAccessKey: "b",
      sessionToken: "c",
    });
    writeTenantSecret.mockResolvedValue("arn:aws:secretsmanager:us-east-1:123456789012:secret:x");
    ensureDocsSignerSecret.mockResolvedValue({
      docsSignerSecretArn: "arn:aws:secretsmanager:us-east-1:123456789012:secret:acme-co/docs-signer-secret",
      docsSignerSecretEncrypted: "enc:docs-signer-secret",
    });
    generateDocsSignerSecret.mockReturnValue({
      docsSignerSecretEncrypted: "enc:azure-docs-signer-secret",
      docsSignerSecretPlaintext: "azure-plaintext-secret",
    });
  });

  it("redirects to /signin when there is no authenticated session", async () => {
    authMock.mockResolvedValue(null);

    await expect(createTenantAndDeploy(null, formData(validAws))).rejects.toThrow("REDIRECT:/signin");
    expect(db.insert).not.toHaveBeenCalled();
  });

  describe("shared field validation", () => {
    it("rejects a slug that is too short", async () => {
      const result = await createTenantAndDeploy(null, formData({ ...validAws, slug: "ab" }));
      expect(result?.errors.slug).toMatch(/at least 3 characters/);
    });

    it("rejects a slug with uppercase letters", async () => {
      const result = await createTenantAndDeploy(null, formData({ ...validAws, slug: "Acme-Co" }));
      expect(result?.errors.slug).toBeDefined();
    });

    it("rejects a slug starting with a hyphen", async () => {
      const result = await createTenantAndDeploy(null, formData({ ...validAws, slug: "-acme" }));
      expect(result?.errors.slug).toBeDefined();
    });

    it("rejects an invalid domain", async () => {
      const result = await createTenantAndDeploy(
        null,
        formData({ ...validAws, domain: "https://chat.acme.com/" }),
      );
      expect(result?.errors.domain).toMatch(/valid hostname/);
    });

    it("accepts an empty domain (optional field)", async () => {
      const result = await createTenantAndDeploy(null, formData({ ...validAws, domain: "" }));
      // Empty domain is valid, so this should deploy rather than return a
      // validation-error object.
      expect(result?.errors).toEqual({});
      expect(result?.deployed).toEqual({
        tenantId: "tenant-1",
        deploymentId: "deploy-1",
        startedAt: "2026-01-01T00:00:00.000Z",
      });
    });

    it("rejects an unrecognized llmProvider", async () => {
      const result = await createTenantAndDeploy(
        null,
        formData({ ...validAws, llmProvider: "made-up-provider" }),
      );
      expect(result?.errors.llmProvider).toMatch(/Select a provider/);
    });

    it("rejects an llmApiKey that is too short", async () => {
      const result = await createTenantAndDeploy(null, formData({ ...validAws, llmApiKey: "short" }));
      expect(result?.errors.llmApiKey).toMatch(/too short/);
    });

    it("requires pineconeApiKey when vectorStore is pinecone", async () => {
      const result = await createTenantAndDeploy(
        null,
        formData({ ...validAws, vectorStore: "pinecone", pineconeApiKey: undefined }),
      );
      expect(result?.errors.pineconeApiKey).toMatch(/Required when the vector store is Pinecone/);
    });

    it("does not require pineconeApiKey when vectorStore is pgvector", async () => {
      const result = await createTenantAndDeploy(
        null,
        formData({ ...validAws, vectorStore: "pgvector", pineconeApiKey: undefined }),
      );
      expect(result?.errors).toEqual({});
      expect(result?.deployed).toBeDefined();
    });

    it("rejects an unrecognized cloudProvider", async () => {
      const result = await createTenantAndDeploy(null, formData({ ...validAws, cloudProvider: "gcp" }));
      expect(result?.errors).toBeTruthy();
      expect(Object.keys(result!.errors).length).toBeGreaterThan(0);
    });
  });

  describe("AWS field validation", () => {
    it("rejects an awsAccountId that is not 12 digits", async () => {
      const result = await createTenantAndDeploy(null, formData({ ...validAws, awsAccountId: "123" }));
      expect(result?.errors.awsAccountId).toMatch(/exactly 12 digits/);
    });

    it("rejects a malformed awsRegion", async () => {
      const result = await createTenantAndDeploy(null, formData({ ...validAws, awsRegion: "useast1" }));
      expect(result?.errors.awsRegion).toMatch(/valid AWS region/);
    });

    it("rejects a malformed deploymentRoleArn", async () => {
      const result = await createTenantAndDeploy(
        null,
        formData({ ...validAws, deploymentRoleArn: "not-an-arn" }),
      );
      expect(result?.errors.deploymentRoleArn).toMatch(/valid IAM role ARN/);
    });

    it("rejects an s3DocsPrefix with a leading slash", async () => {
      const result = await createTenantAndDeploy(
        null,
        formData({ ...validAws, s3DocsPrefix: "/docs" }),
      );
      expect(result?.errors.s3DocsPrefix).toMatch(/leading slash/);
    });
  });

  describe("Azure field validation", () => {
    it("rejects a malformed azureSubscriptionId", async () => {
      const result = await createTenantAndDeploy(
        null,
        formData({ ...validAzure, azureSubscriptionId: "not-a-uuid" }),
      );
      expect(result?.errors.azureSubscriptionId).toMatch(/valid UUID/);
    });

    it("rejects an azureClientId that isn't a UUID", async () => {
      // A slug or secret pasted into the client ID box otherwise reaches Azure
      // and fails mid-deploy as AADSTS700016 ("application not found").
      const result = await createTenantAndDeploy(
        null,
        formData({ ...validAzure, azureClientId: "test2206" }),
      );
      expect(result?.errors.azureClientId).toMatch(/valid UUID/);
    });

    it("rejects an azureTenantId that isn't a UUID", async () => {
      const result = await createTenantAndDeploy(
        null,
        formData({ ...validAzure, azureTenantId: "my-directory" }),
      );
      expect(result?.errors.azureTenantId).toMatch(/valid UUID/);
    });

    it("rejects a missing azureClientSecret", async () => {
      const result = await createTenantAndDeploy(
        null,
        formData({ ...validAzure, azureClientSecret: "" }),
      );
      expect(result?.errors.azureClientSecret).toBeDefined();
    });
  });

  describe("successful submission", () => {
    it("assumes the tenant role and writes both secrets for an AWS + pinecone tenant, then returns the deployment", async () => {
      const result = await createTenantAndDeploy(null, formData(validAws));
      expect(result?.deployed).toEqual({
        tenantId: "tenant-1",
        deploymentId: "deploy-1",
        startedAt: "2026-01-01T00:00:00.000Z",
      });

      expect(assumeTenantRole).toHaveBeenCalledWith(
        expect.objectContaining({ roleArn: validAws.deploymentRoleArn, region: "us-east-1" }),
      );
      expect(writeTenantSecret).toHaveBeenCalledTimes(2); // llm key + pinecone key
      expect(ensureDocsSignerSecret).toHaveBeenCalledWith(
        expect.objectContaining({ roleArn: validAws.deploymentRoleArn, slug: "acme-co" }),
      );
      expect(generateDocsSignerSecret).not.toHaveBeenCalled();
      expect(triggerDeployment).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: "tenant-1", triggeredByUserId: "user-1" }),
      );
    });

    it("does not touch AWS APIs for an Azure tenant, generates a docs-signer secret instead, and encrypts the client secret", async () => {
      const result = await createTenantAndDeploy(null, formData(validAzure));
      expect(result?.deployed).toBeDefined();

      expect(assumeTenantRole).not.toHaveBeenCalled();
      expect(writeTenantSecret).not.toHaveBeenCalled();
      expect(ensureDocsSignerSecret).not.toHaveBeenCalled();
      expect(generateDocsSignerSecret).toHaveBeenCalledWith();
      expect(encryptSecret).toHaveBeenCalledWith(validAzure.azureClientSecret);
      expect(triggerDeployment).toHaveBeenCalled();
    });

    it("writes only the LLM secret (not a Pinecone secret) for an AWS + pgvector tenant", async () => {
      const result = await createTenantAndDeploy(
        null,
        formData({ ...validAws, vectorStore: "pgvector", pineconeApiKey: undefined }),
      );
      expect(result?.deployed).toBeDefined();

      expect(writeTenantSecret).toHaveBeenCalledTimes(1);
    });

    it("deletes the wizard's draft row once the tenant it was for now exists", async () => {
      const result = await createTenantAndDeploy(
        null,
        formData({ ...validAws, draftId: "draft-1" }),
      );

      expect(result?.deployed).toBeDefined();
      expect(db.delete).toHaveBeenCalledWith(tenantDrafts);
    });

    it("does not touch tenantDrafts when the submission carries no draftId", async () => {
      const result = await createTenantAndDeploy(null, formData(validAws));

      expect(result?.deployed).toBeDefined();
      expect(db.delete).not.toHaveBeenCalled();
    });
  });

  describe("unrecognised fields", () => {
    // The wizard posts its whole value map as hidden inputs, so a stale key
    // left over from a resumed draft must not reach the insert.
    it("ignores form fields that are not part of the schema", async () => {
      const result = await createTenantAndDeploy(
        null,
        formData({ ...validAws, llmTemperature: "0.2", somethingRemoved: "x" }),
      );

      expect(result?.deployed).toBeDefined();
      expect(insertedValues()).not.toHaveProperty("llmTemperature");
      expect(insertedValues()).not.toHaveProperty("somethingRemoved");
    });
  });
});

describe("saveTenantDraft", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authMock.mockResolvedValue({ user: { id: "user-1" } });
    dbInsertReturning.mockResolvedValue([
      { id: "draft-1", updatedAt: new Date("2026-01-01T00:00:00Z") },
    ]);
    dbUpdateReturning.mockResolvedValue([
      { id: "draft-1", updatedAt: new Date("2026-01-02T00:00:00Z") },
    ]);
  });

  it("redirects to /signin when there is no authenticated session", async () => {
    authMock.mockResolvedValue(null);

    await expect(saveTenantDraft(null, formData({ name: "Acme" }))).rejects.toThrow(
      "REDIRECT:/signin",
    );
    expect(db.insert).not.toHaveBeenCalled();
  });

  // The headline security property of this action: a draft has no deployment
  // behind it, so persisting a plaintext credential here would leak a real
  // customer secret into the control-plane database for no reason.
  it.each(["llmApiKey", "pineconeApiKey", "azureClientSecret"] as const)(
    "never persists %s, even though it was submitted",
    async (secretField) => {
      await saveTenantDraft(
        null,
        formData({ name: "Acme", [secretField]: "super-secret-value" }),
      );

      expect(insertedValues().data).not.toHaveProperty(secretField);
    },
  );

  it("excludes step and empty-string fields from the persisted data", async () => {
    // No draftId here on purpose — the insert path is what's under test, and
    // submitting one would route this into the update branch instead.
    await saveTenantDraft(null, formData({ name: "Acme", step: "2", domain: "" }));

    const data = insertedValues().data as Record<string, unknown>;
    expect(data).not.toHaveProperty("step");
    expect(data).not.toHaveProperty("domain");
    expect(data.name).toBe("Acme");
  });

  it("sets name to null when the form has no name field", async () => {
    await saveTenantDraft(null, formData({ slug: "acme-co" }));

    expect(insertedValues().name).toBeNull();
  });

  it.each([
    ["1", 1],
    ["5", 5],
    [undefined, 1],
    ["0", 1],
    ["6", 1],
    ["not-a-number", 1],
  ])("normalizes step %s to %i", async (rawStep, expectedStep) => {
    await saveTenantDraft(null, formData({ name: "Acme", step: rawStep }));

    expect(insertedValues().step).toBe(expectedStep);
  });

  it("inserts a new draft when no draftId is given", async () => {
    const result = await saveTenantDraft(null, formData({ name: "Acme" }));

    expect(db.insert).toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
    expect(result).toEqual({ draftId: "draft-1", savedAt: "2026-01-01T00:00:00.000Z" });
  });

  it("updates an existing draft in place when draftId belongs to the session user", async () => {
    const result = await saveTenantDraft(
      null,
      formData({ name: "Acme Renamed", draftId: "draft-1" }),
    );

    expect(db.update).toHaveBeenCalledWith(tenantDrafts);
    expect(db.insert).not.toHaveBeenCalled();
    expect(updatedValues().name).toBe("Acme Renamed");
    expect(result).toEqual({ draftId: "draft-1", savedAt: "2026-01-02T00:00:00.000Z" });
  });

  it("falls through to an insert when the update matches no row (wrong owner or stale id)", async () => {
    dbUpdateReturning.mockResolvedValue([]);

    const result = await saveTenantDraft(
      null,
      formData({ name: "Acme", draftId: "someone-elses-draft" }),
    );

    expect(db.update).toHaveBeenCalled();
    expect(db.insert).toHaveBeenCalled();
    expect(result).toEqual({ draftId: "draft-1", savedAt: "2026-01-01T00:00:00.000Z" });
  });

  it("returns an error instead of throwing when the db operation fails", async () => {
    dbInsertReturning.mockRejectedValue(new Error("connection reset"));

    const result = await saveTenantDraft(null, formData({ name: "Acme" }));

    expect(result).toEqual({ error: "Could not save the draft. Your entries are still on this page." });
  });
});

describe("deleteTenantDraft", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authMock.mockResolvedValue({ user: { id: "user-1" } });
  });

  it("redirects to /signin when there is no authenticated session", async () => {
    authMock.mockResolvedValue(null);

    await expect(deleteTenantDraft("draft-1")).rejects.toThrow("REDIRECT:/signin");
    expect(db.delete).not.toHaveBeenCalled();
  });

  it("deletes from the tenantDrafts table", async () => {
    await deleteTenantDraft("draft-1");

    expect(db.delete).toHaveBeenCalledWith(tenantDrafts);
  });
});
