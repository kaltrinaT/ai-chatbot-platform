import { describe, it, expect, beforeEach, vi } from "vitest";
import { insertValuesReturningChain } from "@/test/db-chains";
import { buildFormData } from "@/test/form-data";

const { authMock, dbInsertReturning, triggerDeployment, encryptSecret, assumeTenantRole, writeTenantSecret, redirectMock } =
  vi.hoisted(() => {
    const authMock = vi.fn();
    const dbInsertReturning = vi.fn();
    const triggerDeployment = vi.fn();
    const encryptSecret = vi.fn((v: string) => `enc:${v}`);
    const assumeTenantRole = vi.fn();
    const writeTenantSecret = vi.fn();
    const redirectMock = vi.fn((url: string) => {
      throw new Error(`REDIRECT:${url}`);
    });
    return {
      authMock,
      dbInsertReturning,
      triggerDeployment,
      encryptSecret,
      assumeTenantRole,
      writeTenantSecret,
      redirectMock,
    };
  });

vi.mock("next/navigation", () => ({ redirect: redirectMock }));
vi.mock("@/auth", () => ({ auth: authMock }));
vi.mock("@/db", () => ({
  db: { insert: vi.fn(() => insertValuesReturningChain(dbInsertReturning)) },
}));
vi.mock("@/lib/deploy", () => ({ triggerDeployment }));
vi.mock("@/lib/crypto", () => ({ encryptSecret }));
vi.mock("@/lib/aws", () => ({ assumeTenantRole, writeTenantSecret }));

import { db } from "@/db";
import { createTenantAndDeploy } from "./actions";

function formData(fields: Record<string, string | undefined>): FormData {
  return buildFormData(fields);
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
  azureTenantId: "az-tenant-1",
  azureClientId: "az-client-1",
  azureClientSecret: "az-secret-1",
  azureRegion: "eastus",
};

describe("createTenantAndDeploy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authMock.mockResolvedValue({ user: { id: "user-1" } });
    dbInsertReturning.mockResolvedValue([{ id: "tenant-1" }]);
    triggerDeployment.mockResolvedValue({ id: "deploy-1" });
    encryptSecret.mockImplementation((v: string) => `enc:${v}`);
    assumeTenantRole.mockResolvedValue({
      accessKeyId: "a",
      secretAccessKey: "b",
      sessionToken: "c",
    });
    writeTenantSecret.mockResolvedValue("arn:aws:secretsmanager:us-east-1:123456789012:secret:x");
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
      const result = await createTenantAndDeploy(null, formData({ ...validAws, domain: "" })).catch(
        (e) => e,
      );
      // Empty domain is valid, so this should proceed to the redirect throw,
      // not return a validation-error object.
      expect(result).toBeInstanceOf(Error);
      expect((result as Error).message).toMatch(/^REDIRECT:/);
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
      ).catch((e) => e);
      expect(result).toBeInstanceOf(Error);
      expect((result as Error).message).toMatch(/^REDIRECT:/);
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

    it("rejects a missing azureClientSecret", async () => {
      const result = await createTenantAndDeploy(
        null,
        formData({ ...validAzure, azureClientSecret: "" }),
      );
      expect(result?.errors.azureClientSecret).toBeDefined();
    });
  });

  describe("successful submission", () => {
    it("assumes the tenant role and writes both secrets for an AWS + pinecone tenant, then redirects", async () => {
      await expect(createTenantAndDeploy(null, formData(validAws))).rejects.toThrow(
        "REDIRECT:/tenants/tenant-1",
      );

      expect(assumeTenantRole).toHaveBeenCalledWith(
        expect.objectContaining({ roleArn: validAws.deploymentRoleArn, region: "us-east-1" }),
      );
      expect(writeTenantSecret).toHaveBeenCalledTimes(2); // llm key + pinecone key
      expect(triggerDeployment).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: "tenant-1", triggeredByUserId: "user-1" }),
      );
    });

    it("does not touch AWS APIs for an Azure tenant, and encrypts the client secret", async () => {
      await expect(createTenantAndDeploy(null, formData(validAzure))).rejects.toThrow(
        "REDIRECT:/tenants/tenant-1",
      );

      expect(assumeTenantRole).not.toHaveBeenCalled();
      expect(writeTenantSecret).not.toHaveBeenCalled();
      expect(encryptSecret).toHaveBeenCalledWith(validAzure.azureClientSecret);
      expect(triggerDeployment).toHaveBeenCalled();
    });

    it("writes only the LLM secret (not a Pinecone secret) for an AWS + pgvector tenant", async () => {
      await expect(
        createTenantAndDeploy(
          null,
          formData({ ...validAws, vectorStore: "pgvector", pineconeApiKey: undefined }),
        ),
      ).rejects.toThrow("REDIRECT:/tenants/tenant-1");

      expect(writeTenantSecret).toHaveBeenCalledTimes(1);
    });
  });
});
