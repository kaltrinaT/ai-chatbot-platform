import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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
import {
  DeploymentInProgressError,
  triggerDeployment,
  triggerTenantDestroy,
  retrievalMinScore,
} from "./deploy";

/**
 * The input names a workflow accepts. A dispatch carrying anything else is
 * rejected by GitHub, so the platform's inputs and the workflow file have to
 * agree exactly.
 */
function declaredInputs(workflowFile: string): string[] {
  const workflow = readFileSync(join(process.cwd(), ".github/workflows", workflowFile), "utf8");
  const inputsBlock = workflow.split(/^    inputs:$/m)[1].split(/^\S/m)[0];
  return [...inputsBlock.matchAll(/^      ([a-z0-9_]+):$/gm)].map((m) => m[1]).sort();
}

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

  describe("the CloudFront front door", () => {
    const saved = process.env.PLATFORM_ENABLE_CDN;

    afterEach(() => {
      if (saved === undefined) delete process.env.PLATFORM_ENABLE_CDN;
      else process.env.PLATFORM_ENABLE_CDN = saved;
    });

    async function dispatchAndReadInputs(id: string) {
      dbSelectWhere.mockResolvedValue([baseAwsTenant]);
      dbInsertReturning.mockResolvedValue([{ id, status: "pending" }]);
      dbUpdateWhere.mockResolvedValue(undefined);
      createWorkflowDispatch.mockResolvedValue({});

      await triggerDeployment({
        tenantId: baseAwsTenant.id,
        chatbotVersion: "v1",
        triggeredByUserId: "u1",
      });

      return createWorkflowDispatch.mock.calls[0][0].inputs;
    }

    it("is on unless the platform says otherwise, since it is the only HTTPS a tenant without a certificate gets", async () => {
      delete process.env.PLATFORM_ENABLE_CDN;
      expect((await dispatchAndReadInputs("deploy-cdn-1")).enable_cdn).toBe("true");
    });

    // An AWS account that has not been verified for CloudFront cannot create a
    // distribution at all, and the whole deploy fails on it.
    it.each(["false", "FALSE", "0", "off"])("is off when set to %s", async (value) => {
      process.env.PLATFORM_ENABLE_CDN = value;
      expect((await dispatchAndReadInputs("deploy-cdn-2")).enable_cdn).toBe("false");
    });
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
    // The job's GitHub environment, and so the subject the customer's
    // federated credential trusts, is derived from this.
    expect(call.inputs.tenant_id).toBe(baseAzureTenant.id);
    // The run fetches these itself with its OIDC token; as inputs they would
    // sit in the run's event payload (see deploymentSecrets.ts).
    expect(call.inputs).not.toHaveProperty("llm_api_key");
    expect(call.inputs).not.toHaveProperty("pinecone_api_key");
    expect(call.inputs).not.toHaveProperty("docs_signer_secret");
    expect(decryptSecret).not.toHaveBeenCalled();
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

  // Same parity check as the Azure one below. It also pins the tenant ID:
  // that is what names the GitHub environment the job runs in, so dropping it
  // from the dispatch would leave the run with no per-tenant subject and the
  // customer's role would refuse it.
  it("sends exactly the inputs deploy-tenant.yml declares, including the tenant ID", async () => {
    dbSelectWhere.mockResolvedValue([baseAwsTenant]);
    dbInsertReturning.mockResolvedValue([{ id: "deploy-1", status: "pending" }]);
    dbUpdateWhere.mockResolvedValue(undefined);
    createWorkflowDispatch.mockResolvedValue({});

    await triggerDeployment({ tenantId: baseAwsTenant.id, chatbotVersion: "v1", triggeredByUserId: "u1" });

    const inputs = createWorkflowDispatch.mock.calls[0][0].inputs;
    expect(Object.keys(inputs).sort()).toEqual(declaredInputs("deploy-tenant.yml"));
    expect(inputs.tenant_id).toBe(baseAwsTenant.id);
  });

  // GitHub rejects a dispatch carrying an input the workflow does not declare,
  // so a key left behind here fails every Azure deploy at dispatch time. This
  // is also what proves no Azure credential travels: the workflow no longer
  // declares one to receive.
  it("sends exactly the inputs deploy-tenant-azure.yml declares, none of them an Azure credential", async () => {
    dbSelectWhere.mockResolvedValue([baseAzureTenant]);
    dbInsertReturning.mockResolvedValue([{ id: "deploy-2", status: "pending" }]);
    dbUpdateWhere.mockResolvedValue(undefined);
    createWorkflowDispatch.mockResolvedValue({});

    await triggerDeployment({ tenantId: baseAzureTenant.id, chatbotVersion: "v2", triggeredByUserId: "u2" });

    const sent = Object.keys(createWorkflowDispatch.mock.calls[0][0].inputs).sort();
    expect(sent).toEqual(declaredInputs("deploy-tenant-azure.yml"));
    expect(sent.some((name) => /client_secret|password|credential/.test(name))).toBe(false);
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

  // Two requests racing past the UI (a double click, or a redeploy during a
  // teardown) would otherwise run Terraform on one state at once.
  it.each([
    ["the driver's error", { code: "23505", constraint: "deployments_one_active_per_tenant" }],
    [
      "an ORM-wrapped error",
      {
        cause: Object.assign(new Error('duplicate key value violates unique constraint "deployments_one_active_per_tenant"'), {
          code: "23505",
        }),
      },
    ],
  ])("refuses a second active deployment for the tenant (%s)", async (_label, shape) => {
    dbSelectWhere.mockResolvedValue([baseAwsTenant]);
    dbInsertReturning.mockRejectedValue(Object.assign(new Error("insert failed"), shape));

    await expect(
      triggerDeployment({ tenantId: baseAwsTenant.id, chatbotVersion: "v1", triggeredByUserId: "u1" }),
    ).rejects.toThrow(/already in progress/);

    expect(createWorkflowDispatch).not.toHaveBeenCalled();
  });

  it("does not mistake an unrelated database error for a conflict", async () => {
    dbSelectWhere.mockResolvedValue([baseAwsTenant]);
    dbInsertReturning.mockRejectedValue(Object.assign(new Error("connection reset"), { code: "08006" }));

    await expect(
      triggerDeployment({ tenantId: baseAwsTenant.id, chatbotVersion: "v1", triggeredByUserId: "u1" }),
    ).rejects.toThrow("connection reset");
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

  // Teardown used to refuse anything but AWS, which left an Azure tenant
  // removable only by hand in the portal.
  it("sends an Azure tenant to the Azure teardown workflow", async () => {
    const azureTenant = {
      ...destroyTenant,
      cloudProvider: "azure",
      azureSubscriptionId: "11111111-1111-1111-1111-111111111111",
      azureTenantId: "22222222-2222-2222-2222-222222222222",
      azureClientId: "33333333-3333-3333-3333-333333333333",
      azureRegion: "westeurope",
    };
    dbSelectWhere.mockResolvedValueOnce([azureTenant]).mockResolvedValueOnce([]);

    await triggerTenantDestroy({ tenantId: azureTenant.id, triggeredByUserId: "u1" });

    const call = createWorkflowDispatch.mock.calls[0][0];
    expect(call.workflow_id).toBe("destroy-tenant-azure.yml");
    expect(Object.keys(call.inputs).sort()).toEqual(declaredInputs("destroy-tenant-azure.yml"));
    // Names the GitHub environment the teardown runs in, and so the subject
    // the customer's federated credential has to accept.
    expect(call.inputs.tenant_id).toBe(azureTenant.id);
    expect(JSON.parse(call.inputs.config)).toMatchObject({
      azure_subscription_id: azureTenant.azureSubscriptionId,
      azure_client_id: azureTenant.azureClientId,
      azure_region: "westeurope",
    });
  });

  // Even the Pinecone key a teardown needs is fetched by the run itself.
  it("sends no secret at all when tearing Azure down", async () => {
    dbSelectWhere
      .mockResolvedValueOnce([
        { ...destroyTenant, cloudProvider: "azure", pineconeApiKeyEncrypted: "iv:tag:pc" },
      ])
      .mockResolvedValueOnce([]);

    await triggerTenantDestroy({ tenantId: destroyTenant.id, triggeredByUserId: "u1" });

    const inputs = createWorkflowDispatch.mock.calls[0][0].inputs;
    expect(inputs).not.toHaveProperty("llm_api_key");
    expect(inputs).not.toHaveProperty("docs_signer_secret");
    expect(inputs).not.toHaveProperty("pinecone_api_key");
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

  it("empties tenant_documents via the docs-signer before dispatching, best-effort", async () => {
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
    // Only doc-1's object was really deleted, so only its row goes; doc-2's
    // row keeps showing what storage still holds.
    expect(dbDeleteWhere).toHaveBeenCalledTimes(1);
    expect(createWorkflowDispatch).toHaveBeenCalled();
  });

  // A tenant has one slot for work in flight. A teardown that loses it must
  // not have deleted anything first.
  it("refuses while another deployment is in progress, before touching any document", async () => {
    dbSelectWhere.mockResolvedValue([destroyTenant]);
    dbInsertReturning.mockRejectedValue(
      Object.assign(new Error("duplicate key"), {
        code: "23505",
        constraint: "deployments_one_active_per_tenant",
      }),
    );

    await expect(
      triggerTenantDestroy({ tenantId: destroyTenant.id, triggeredByUserId: "u1" }),
    ).rejects.toBeInstanceOf(DeploymentInProgressError);

    expect(deleteViaSigner).not.toHaveBeenCalled();
    expect(dbDeleteWhere).not.toHaveBeenCalled();
    expect(createWorkflowDispatch).not.toHaveBeenCalled();
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
    // Teardown federates exactly as a deploy does, so it has to carry the same
    // per-tenant binding — otherwise the run has no environment, its token
    // carries no matching subject, and a customer could never have their
    // infrastructure removed.
    expect(inputs.tenant_id).toBe(destroyTenant.id);
    expect(Object.keys(inputs).sort()).toEqual(declaredInputs("destroy-tenant.yml"));
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

describe("retrievalMinScore", () => {
  it("returns an empty string when the tenant has no override", () => {
    expect(retrievalMinScore(null)).toBe("");
    expect(retrievalMinScore({})).toBe("");
    expect(retrievalMinScore({ retrieval_min_score: "" })).toBe("");
  });

  it("passes through a valid override, as a string", () => {
    expect(retrievalMinScore({ retrieval_min_score: 0.25 })).toBe("0.25");
    expect(retrievalMinScore({ retrieval_min_score: "0.4" })).toBe("0.4");
  });

  it("keeps 0, which is a real setting and not an absent one", () => {
    // Distinct from "" — it disables the gate rather than falling back to the
    // container default, and a truthiness check would silently swallow it.
    expect(retrievalMinScore({ retrieval_min_score: 0 })).toBe("0");
  });

  it("ignores values outside 0..1 rather than blocking the deploy", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(retrievalMinScore({ retrieval_min_score: 1.5 })).toBe("");
    expect(retrievalMinScore({ retrieval_min_score: -0.2 })).toBe("");
    expect(retrievalMinScore({ retrieval_min_score: "not a number" })).toBe("");
    warn.mockRestore();
  });
});
