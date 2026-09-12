import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  selectWhereChain,
  updateSetWhereChain,
  insertValuesReturningChain,
  deleteWhereChain,
} from "@/test/db-chains";

const {
  dbSelectWhere,
  dbInsertReturning,
  dbUpdateWhere,
  dbDeleteWhere,
  decryptSecret,
  createWorkflowDispatch,
  getChatbotRepo,
  getDeployWorkflowId,
  getDestroyWorkflowId,
  getOctokit,
  deleteViaSigner,
} = vi.hoisted(() => {
  const dbSelectWhere = vi.fn();
  const dbInsertReturning = vi.fn();
  const dbUpdateWhere = vi.fn();
  const dbDeleteWhere = vi.fn();

  const decryptSecret = vi.fn((blob: string) => `decrypted:${blob}`);

  const createWorkflowDispatch = vi.fn();
  const getChatbotRepo = vi.fn(() => ({ owner: "acme", repo: "chatbot" }));
  const getDeployWorkflowId = vi.fn(() => "deploy-tenant.yml");
  const getDestroyWorkflowId = vi.fn(() => "destroy-tenant.yml");
  const getOctokit = vi.fn(() => ({ actions: { createWorkflowDispatch } }));
  const deleteViaSigner = vi.fn();

  return {
    dbSelectWhere,
    dbInsertReturning,
    dbUpdateWhere,
    dbDeleteWhere,
    decryptSecret,
    createWorkflowDispatch,
    getChatbotRepo,
    getDeployWorkflowId,
    getDestroyWorkflowId,
    getOctokit,
    deleteViaSigner,
  };
});

// Built inside the factory (not in vi.hoisted) so it can use the shared
// chain helpers: vi.mock factories run lazily, when "@/db" is first
// imported — by which time this file's own `@/test/db-chains` import has
// already resolved, since regular imports run in source order after the
// vi.hoisted() call above. Referencing the helpers from inside vi.hoisted
// itself would fail: that callback runs before any of this file's imports.
vi.mock("@/db", () => ({
  db: {
    select: vi.fn(() => selectWhereChain(dbSelectWhere)),
    insert: vi.fn(() => insertValuesReturningChain(dbInsertReturning)),
    update: vi.fn(() => updateSetWhereChain(dbUpdateWhere)),
    delete: vi.fn(() => deleteWhereChain(dbDeleteWhere)),
  },
}));
vi.mock("@/lib/crypto", () => ({ decryptSecret }));
vi.mock("@/lib/github", () => ({
  getChatbotRepo,
  getDeployWorkflowId,
  getDestroyWorkflowId,
  getOctokit,
}));
vi.mock("@/lib/docsSigner", () => ({ deleteViaSigner }));

import { db } from "@/db";
import { triggerDeployment, triggerTenantDestroy } from "./deploy";

const baseAwsTenant = {
  id: "tenant-1",
  slug: "acme-co",
  cloudProvider: "aws" as const,
  llmProvider: "openai",
  llmModel: "gpt-4o",
  llmSecretArn: "arn:aws:secretsmanager:us-east-1:111111111111:secret:acme-co/llm-api-key",
  awsAccountId: "111111111111",
  awsRegion: "us-east-1",
  deploymentRoleArn: "arn:aws:iam::111111111111:role/deploy",
  domain: "chat.acme.com",
  s3DocsPrefix: "docs/",
  vectorStore: "pinecone",
  pineconeSecretArn: "arn:aws:secretsmanager:us-east-1:111111111111:secret:acme-co/pinecone-api-key",
  docsSignerSecretArn: "arn:aws:secretsmanager:us-east-1:111111111111:secret:acme-co/docs-signer-secret",
  docsSignerSecretEncrypted: "iv:tag:docssignerct",
};

const baseAzureTenant = {
  id: "tenant-2",
  slug: "beta-co",
  cloudProvider: "azure" as const,
  llmProvider: "anthropic",
  llmModel: "claude-sonnet",
  llmApiKeyEncrypted: "iv:tag:llmct",
  azureSubscriptionId: "sub-1",
  azureTenantId: "az-tenant-1",
  azureClientId: "az-client-1",
  azureClientSecretEncrypted: "iv:tag:secretct",
  azureRegion: "eastus",
  domain: "chat.beta.com",
  vectorStore: "pgvector",
  pineconeApiKeyEncrypted: null,
  docsSignerSecretEncrypted: "iv:tag:azuredocssignerct",
};

describe("triggerDeployment", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    decryptSecret.mockImplementation((blob: string) => `decrypted:${blob}`);
    getChatbotRepo.mockReturnValue({ owner: "acme", repo: "chatbot" });
    getDeployWorkflowId.mockReturnValue("deploy-tenant.yml");
    getOctokit.mockReturnValue({ actions: { createWorkflowDispatch } });
    process.env.PLATFORM_CHATBOT_IMAGE_URI = "111111111111.dkr.ecr.us-east-1.amazonaws.com/chatbot";
    process.env.PLATFORM_FRONTEND_IMAGE_URI = "111111111111.dkr.ecr.us-east-1.amazonaws.com/frontend";
    delete process.env.CHATBOT_DEPLOY_REF;
  });

  it("throws when the tenant does not exist", async () => {
    dbSelectWhere.mockResolvedValue([]);

    await expect(
      triggerDeployment({ tenantId: "missing", chatbotVersion: "latest", triggeredByUserId: "u1" }),
    ).rejects.toThrow(/Tenant missing not found/);
  });

  it("throws when the platform image URI env vars are missing (AWS tenant)", async () => {
    dbSelectWhere.mockResolvedValue([baseAwsTenant]);
    delete process.env.PLATFORM_CHATBOT_IMAGE_URI;

    await expect(
      triggerDeployment({ tenantId: baseAwsTenant.id, chatbotVersion: "v1", triggeredByUserId: "u1" }),
    ).rejects.toThrow(/PLATFORM_CHATBOT_IMAGE_URI is not set/);
  });

  it("throws when the platform image URI env vars are missing (Azure tenant)", async () => {
    dbSelectWhere.mockResolvedValue([baseAzureTenant]);
    delete process.env.PLATFORM_CHATBOT_IMAGE_URI;

    await expect(
      triggerDeployment({ tenantId: baseAzureTenant.id, chatbotVersion: "v1", triggeredByUserId: "u1" }),
    ).rejects.toThrow(/PLATFORM_CHATBOT_IMAGE_URI is not set/);
  });

  it("throws when only PLATFORM_FRONTEND_IMAGE_URI is missing", async () => {
    dbSelectWhere.mockResolvedValue([baseAwsTenant]);
    delete process.env.PLATFORM_FRONTEND_IMAGE_URI;

    await expect(
      triggerDeployment({ tenantId: baseAwsTenant.id, chatbotVersion: "v1", triggeredByUserId: "u1" }),
    ).rejects.toThrow(/PLATFORM_FRONTEND_IMAGE_URI is not set/);
  });

  it("throws when an AWS tenant has no llmSecretArn", async () => {
    dbSelectWhere.mockResolvedValue([{ ...baseAwsTenant, llmSecretArn: null }]);

    await expect(
      triggerDeployment({ tenantId: baseAwsTenant.id, chatbotVersion: "v1", triggeredByUserId: "u1" }),
    ).rejects.toThrow(/has no llmSecretArn/);
  });

  it("throws when an Azure tenant has no encrypted LLM key", async () => {
    dbSelectWhere.mockResolvedValue([{ ...baseAzureTenant, llmApiKeyEncrypted: null }]);

    await expect(
      triggerDeployment({ tenantId: baseAzureTenant.id, chatbotVersion: "v1", triggeredByUserId: "u1" }),
    ).rejects.toThrow(/has no encrypted LLM key/);
  });

  it("throws when a pinecone tenant has no customer Pinecone key on file (AWS)", async () => {
    dbSelectWhere.mockResolvedValue([{ ...baseAwsTenant, pineconeSecretArn: null }]);

    await expect(
      triggerDeployment({ tenantId: baseAwsTenant.id, chatbotVersion: "v1", triggeredByUserId: "u1" }),
    ).rejects.toThrow(/uses Pinecone but has no customer Pinecone key on file/);
  });

  it("throws when a pinecone tenant has no customer Pinecone key on file (Azure)", async () => {
    dbSelectWhere.mockResolvedValue([
      { ...baseAzureTenant, vectorStore: "pinecone", pineconeApiKeyEncrypted: null },
    ]);

    await expect(
      triggerDeployment({ tenantId: baseAzureTenant.id, chatbotVersion: "v1", triggeredByUserId: "u1" }),
    ).rejects.toThrow(/uses Pinecone but has no customer Pinecone key on file/);
  });

  it("dispatches the AWS workflow with the expected inputs and marks the deployment running", async () => {
    dbSelectWhere.mockResolvedValue([baseAwsTenant]);
    dbInsertReturning.mockResolvedValue([{ id: "deploy-1", status: "pending" }]);
    dbUpdateWhere.mockResolvedValue(undefined);
    createWorkflowDispatch.mockResolvedValue({});

    const result = await triggerDeployment({
      tenantId: baseAwsTenant.id,
      chatbotVersion: "v1.2.3",
      triggeredByUserId: "u1",
    });

    expect(result).toEqual({ id: "deploy-1", status: "pending" });
    expect(createWorkflowDispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: "acme",
        repo: "chatbot",
        workflow_id: "deploy-tenant.yml",
        ref: "main",
        inputs: expect.objectContaining({
          deployment_id: "deploy-1",
          tenant_slug: "acme-co",
          aws_account_id: "111111111111",
          your_ecr_image: "111111111111.dkr.ecr.us-east-1.amazonaws.com/chatbot:v1.2.3",
          your_frontend_ecr_image: "111111111111.dkr.ecr.us-east-1.amazonaws.com/frontend:v1.2.3",
          vector_store: "pinecone",
          pinecone_secret_arn: baseAwsTenant.pineconeSecretArn,
          docs_signer_secret_arn: baseAwsTenant.docsSignerSecretArn,
        }),
      }),
    );
    expect(dbUpdateWhere).toHaveBeenCalled();
  });

  it("forwards the tenant's TLS certificate ARN, so a redeploy keeps its HTTPS listener", async () => {
    const certArn = "arn:aws:acm:us-east-1:111111111111:certificate/abc-123";
    dbSelectWhere.mockResolvedValue([{ ...baseAwsTenant, acmCertificateArn: certArn }]);
    dbInsertReturning.mockResolvedValue([{ id: "deploy-6", status: "pending" }]);
    dbUpdateWhere.mockResolvedValue(undefined);
    createWorkflowDispatch.mockResolvedValue({});

    await triggerDeployment({
      tenantId: baseAwsTenant.id,
      chatbotVersion: "v1",
      triggeredByUserId: "u1",
    });

    expect(createWorkflowDispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        inputs: expect.objectContaining({ acm_certificate_arn: certArn }),
      }),
    );
  });

  it("sends an empty certificate ARN rather than omitting it, which GitHub rejects", async () => {
    dbSelectWhere.mockResolvedValue([{ ...baseAwsTenant, acmCertificateArn: null }]);
    dbInsertReturning.mockResolvedValue([{ id: "deploy-7", status: "pending" }]);
    dbUpdateWhere.mockResolvedValue(undefined);
    createWorkflowDispatch.mockResolvedValue({});

    await triggerDeployment({
      tenantId: baseAwsTenant.id,
      chatbotVersion: "v1",
      triggeredByUserId: "u1",
    });

    const call = createWorkflowDispatch.mock.calls[0][0];
    expect(call.inputs.acm_certificate_arn).toBe("");
  });

  // Onboarding writes this secret before the tenant row exists, so a tenant
  // without it is inconsistent. Deploy refuses rather than generating one,
  // which would mean calling STS into the customer's account on a redeploy.
  it("refuses to deploy an AWS tenant with no docs-signer secret ARN", async () => {
    dbSelectWhere.mockResolvedValue([{ ...baseAwsTenant, docsSignerSecretArn: null }]);

    await expect(
      triggerDeployment({ tenantId: baseAwsTenant.id, chatbotVersion: "v1", triggeredByUserId: "u1" }),
    ).rejects.toThrow("no docsSignerSecretArn");

    expect(dbInsertReturning).not.toHaveBeenCalled();
    expect(createWorkflowDispatch).not.toHaveBeenCalled();
  });

  it("uses deploy-tenant-azure.yml and JSON-packs config for Azure tenants", async () => {
    dbSelectWhere.mockResolvedValue([baseAzureTenant]);
    dbInsertReturning.mockResolvedValue([{ id: "deploy-2", status: "pending" }]);
    dbUpdateWhere.mockResolvedValue(undefined);
    createWorkflowDispatch.mockResolvedValue({});

    await triggerDeployment({
      tenantId: baseAzureTenant.id,
      chatbotVersion: "v2",
      triggeredByUserId: "u2",
    });

    const call = createWorkflowDispatch.mock.calls[0][0];
    expect(call.workflow_id).toBe("deploy-tenant-azure.yml");
    expect(call.inputs.azure_client_secret).toBe(`decrypted:${baseAzureTenant.azureClientSecretEncrypted}`);
    expect(call.inputs.llm_api_key).toBe(`decrypted:${baseAzureTenant.llmApiKeyEncrypted}`);
    expect(call.inputs.pinecone_api_key).toBe("");
    expect(call.inputs.docs_signer_secret).toBe(`decrypted:${baseAzureTenant.docsSignerSecretEncrypted}`);
    expect(call.inputs.your_ecr_image).toBe(
      "111111111111.dkr.ecr.us-east-1.amazonaws.com/chatbot:v2",
    );
    expect(call.inputs.your_frontend_ecr_image).toBe(
      "111111111111.dkr.ecr.us-east-1.amazonaws.com/frontend:v2",
    );

    const config = JSON.parse(call.inputs.config);
    expect(config).toMatchObject({
      azure_subscription_id: baseAzureTenant.azureSubscriptionId,
      azure_region: "eastus",
      vector_store: "pgvector",
      chatbot_version: "v2",
    });
    expect(config).not.toHaveProperty("your_ecr_image");
    expect(config).not.toHaveProperty("your_frontend_ecr_image");
  });

  it("refuses to deploy an Azure tenant with no encrypted docs-signer secret", async () => {
    dbSelectWhere.mockResolvedValue([{ ...baseAzureTenant, docsSignerSecretEncrypted: null }]);

    await expect(
      triggerDeployment({ tenantId: baseAzureTenant.id, chatbotVersion: "v1", triggeredByUserId: "u1" }),
    ).rejects.toThrow("no encrypted docs-signer secret");

    expect(dbInsertReturning).not.toHaveBeenCalled();
    expect(createWorkflowDispatch).not.toHaveBeenCalled();
  });

  it("marks the deployment failed and rethrows when workflow dispatch fails", async () => {
    dbSelectWhere.mockResolvedValue([baseAwsTenant]);
    dbInsertReturning.mockResolvedValue([{ id: "deploy-3", status: "pending" }]);
    dbUpdateWhere.mockResolvedValue(undefined);
    createWorkflowDispatch.mockRejectedValue(new Error("GitHub API unavailable"));

    await expect(
      triggerDeployment({ tenantId: baseAwsTenant.id, chatbotVersion: "v1", triggeredByUserId: "u1" }),
    ).rejects.toThrow("GitHub API unavailable");

    expect(db.update).toHaveBeenCalled();
    expect(dbUpdateWhere).toHaveBeenCalled();
  });

  it("honors CHATBOT_DEPLOY_REF when set", async () => {
    process.env.CHATBOT_DEPLOY_REF = "release";
    dbSelectWhere.mockResolvedValue([baseAwsTenant]);
    dbInsertReturning.mockResolvedValue([{ id: "deploy-4", status: "pending" }]);
    dbUpdateWhere.mockResolvedValue(undefined);
    createWorkflowDispatch.mockResolvedValue({});

    await triggerDeployment({ tenantId: baseAwsTenant.id, chatbotVersion: "v1", triggeredByUserId: "u1" });

    expect(createWorkflowDispatch).toHaveBeenCalledWith(expect.objectContaining({ ref: "release" }));
  });
});

describe("triggerTenantDestroy", () => {
  const destroyTenant = {
    ...baseAwsTenant,
    docsSignerUrl: "https://abc.lambda-url.us-east-1.on.aws/",
    docsSignerSecretEncrypted: "iv:tag:docssignerct",
    deletedAt: null,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    getChatbotRepo.mockReturnValue({ owner: "acme", repo: "chatbot" });
    getDestroyWorkflowId.mockReturnValue("destroy-tenant.yml");
    getOctokit.mockReturnValue({ actions: { createWorkflowDispatch } });
    dbInsertReturning.mockResolvedValue([{ id: "destroy-1", kind: "destroy", status: "pending" }]);
    dbUpdateWhere.mockResolvedValue(undefined);
    dbDeleteWhere.mockResolvedValue(undefined);
    createWorkflowDispatch.mockResolvedValue({});
  });

  it("throws for a non-AWS tenant without touching docs or dispatching anything", async () => {
    dbSelectWhere.mockResolvedValue([{ ...destroyTenant, cloudProvider: "azure" }]);

    await expect(
      triggerTenantDestroy({ tenantId: destroyTenant.id, triggeredByUserId: "u1" }),
    ).rejects.toThrow(/only available for AWS tenants/);

    expect(deleteViaSigner).not.toHaveBeenCalled();
    expect(createWorkflowDispatch).not.toHaveBeenCalled();
  });

  it("throws for a tenant that's already been deleted", async () => {
    dbSelectWhere.mockResolvedValue([
      { ...destroyTenant, deletedAt: new Date("2026-01-01T00:00:00Z") },
    ]);

    await expect(
      triggerTenantDestroy({ tenantId: destroyTenant.id, triggeredByUserId: "u1" }),
    ).rejects.toThrow(/already been deleted/);

    expect(createWorkflowDispatch).not.toHaveBeenCalled();
  });

  it("empties every tenant_documents row via the docs-signer before dispatching, best-effort", async () => {
    dbSelectWhere
      .mockResolvedValueOnce([destroyTenant]) // tenant lookup
      .mockResolvedValueOnce([
        { id: "doc-1", objectKey: "docs/a.pdf" },
        { id: "doc-2", objectKey: "docs/b.pdf" },
      ]); // tenant_documents
    deleteViaSigner
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("lambda unreachable")); // best-effort — must not abort the destroy

    await triggerTenantDestroy({ tenantId: destroyTenant.id, triggeredByUserId: "u1" });

    expect(deleteViaSigner).toHaveBeenCalledTimes(2);
    expect(deleteViaSigner).toHaveBeenNthCalledWith(1, destroyTenant, "docs/a.pdf");
    expect(deleteViaSigner).toHaveBeenNthCalledWith(2, destroyTenant, "docs/b.pdf");
    expect(dbDeleteWhere).toHaveBeenCalled();
    expect(createWorkflowDispatch).toHaveBeenCalled();
  });

  it("skips the docs cleanup entirely when the tenant has no docsSignerUrl", async () => {
    dbSelectWhere.mockResolvedValue([{ ...destroyTenant, docsSignerUrl: null }]);

    await triggerTenantDestroy({ tenantId: destroyTenant.id, triggeredByUserId: "u1" });

    expect(deleteViaSigner).not.toHaveBeenCalled();
    expect(dbDeleteWhere).not.toHaveBeenCalled();
  });

  it("dispatches destroy-tenant.yml with a destroy-kind deployment row and no image inputs", async () => {
    dbSelectWhere.mockResolvedValueOnce([destroyTenant]).mockResolvedValueOnce([]);

    await triggerTenantDestroy({ tenantId: destroyTenant.id, triggeredByUserId: "u1" });

    expect(dbInsertReturning).toHaveBeenCalled();
    const insertedValues = db.insert.mock.results[0].value.values.mock.calls[0][0];
    expect(insertedValues).toMatchObject({ kind: "destroy", status: "pending" });

    expect(createWorkflowDispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: "acme",
        repo: "chatbot",
        workflow_id: "destroy-tenant.yml",
        inputs: expect.objectContaining({
          tenant_slug: destroyTenant.slug,
          deployment_role_arn: destroyTenant.deploymentRoleArn,
          docs_signer_secret_arn: destroyTenant.docsSignerSecretArn,
        }),
      }),
    );
    const inputs = createWorkflowDispatch.mock.calls[0][0].inputs;
    expect(inputs).not.toHaveProperty("your_ecr_image");
    expect(inputs).not.toHaveProperty("your_frontend_ecr_image");
  });

  it("marks the deployment failed and rethrows when workflow dispatch fails", async () => {
    dbSelectWhere.mockResolvedValueOnce([destroyTenant]).mockResolvedValueOnce([]);
    createWorkflowDispatch.mockRejectedValue(new Error("GitHub API unavailable"));

    await expect(
      triggerTenantDestroy({ tenantId: destroyTenant.id, triggeredByUserId: "u1" }),
    ).rejects.toThrow("GitHub API unavailable");

    expect(dbUpdateWhere).toHaveBeenCalled();
  });
});
