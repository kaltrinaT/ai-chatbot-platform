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
  ensureDocsSignerSecret,
  generateDocsSignerSecret,
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
  const ensureDocsSignerSecret = vi.fn();
  const generateDocsSignerSecret = vi.fn();
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
    ensureDocsSignerSecret,
    generateDocsSignerSecret,
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
vi.mock("@/lib/aws", () => ({ ensureDocsSignerSecret }));
vi.mock("@/lib/azure", () => ({ generateDocsSignerSecret }));
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
    ensureDocsSignerSecret.mockResolvedValue({
      docsSignerSecretArn: "arn:aws:secretsmanager:us-east-1:111111111111:secret:acme-co/docs-signer-secret",
      docsSignerSecretEncrypted: "iv:tag:docssignerct",
    });
    generateDocsSignerSecret.mockReturnValue({
      docsSignerSecretEncrypted: "iv:tag:azuredocssignerct",
      docsSignerSecretPlaintext: "azure-plaintext-secret",
    });
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

  it("throws when an AWS tenant image URI env vars are missing", async () => {
    dbSelectWhere.mockResolvedValue([baseAwsTenant]);
    delete process.env.PLATFORM_CHATBOT_IMAGE_URI;

    await expect(
      triggerDeployment({ tenantId: baseAwsTenant.id, chatbotVersion: "v1", triggeredByUserId: "u1" }),
    ).rejects.toThrow(/PLATFORM_CHATBOT_IMAGE_URI is not set/);
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
    expect(ensureDocsSignerSecret).not.toHaveBeenCalled();
  });

  it("lazily generates and stores the docs-signer secret for AWS tenants missing one", async () => {
    dbSelectWhere.mockResolvedValue([{ ...baseAwsTenant, docsSignerSecretArn: null }]);
    dbInsertReturning.mockResolvedValue([{ id: "deploy-5", status: "pending" }]);
    dbUpdateWhere.mockResolvedValue(undefined);
    createWorkflowDispatch.mockResolvedValue({});

    await triggerDeployment({
      tenantId: baseAwsTenant.id,
      chatbotVersion: "v1",
      triggeredByUserId: "u1",
    });

    expect(ensureDocsSignerSecret).toHaveBeenCalledWith(
      expect.objectContaining({ roleArn: baseAwsTenant.deploymentRoleArn, slug: baseAwsTenant.slug }),
    );
    expect(createWorkflowDispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        inputs: expect.objectContaining({
          docs_signer_secret_arn:
            "arn:aws:secretsmanager:us-east-1:111111111111:secret:acme-co/docs-signer-secret",
        }),
      }),
    );
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
    expect(generateDocsSignerSecret).not.toHaveBeenCalled();

    const config = JSON.parse(call.inputs.config);
    expect(config).toMatchObject({
      azure_subscription_id: baseAzureTenant.azureSubscriptionId,
      azure_region: "eastus",
      vector_store: "pgvector",
      chatbot_version: "v2",
    });
  });

  it("lazily generates and stores the docs-signer secret for Azure tenants missing one", async () => {
    dbSelectWhere.mockResolvedValue([{ ...baseAzureTenant, docsSignerSecretEncrypted: null }]);
    dbInsertReturning.mockResolvedValue([{ id: "deploy-6", status: "pending" }]);
    dbUpdateWhere.mockResolvedValue(undefined);
    createWorkflowDispatch.mockResolvedValue({});

    await triggerDeployment({
      tenantId: baseAzureTenant.id,
      chatbotVersion: "v1",
      triggeredByUserId: "u1",
    });

    expect(generateDocsSignerSecret).toHaveBeenCalledWith();
    expect(createWorkflowDispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        inputs: expect.objectContaining({
          docs_signer_secret: "decrypted:iv:tag:azuredocssignerct",
        }),
      }),
    );
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
