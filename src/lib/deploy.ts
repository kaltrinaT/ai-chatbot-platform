import { db } from "@/db";
import { deployments, tenants, tenantDocuments } from "@/db/schema";
import { eq } from "drizzle-orm";
import { decryptSecret } from "@/lib/crypto";
import { getChatbotRepo, getDeployWorkflowId, getDestroyWorkflowId, getOctokit } from "@/lib/github";
import { deleteViaSigner } from "@/lib/docsSigner";

type TriggerInput = {
  tenantId: string;
  chatbotVersion: string;
  triggeredByUserId: string;
};

export async function triggerDeployment({
  tenantId,
  chatbotVersion,
  triggeredByUserId,
}: TriggerInput) {
  const [tenant] = await db.select().from(tenants).where(eq(tenants.id, tenantId));
  if (!tenant) throw new Error(`Tenant ${tenantId} not found`);

  const { owner, repo } = getChatbotRepo();
  const ref = process.env.CHATBOT_DEPLOY_REF ?? "main";

  // Both AWS and Azure replicate the same platform-owned golden image into
  // the tenant's own registry (ECR or ACR) rather than building the
  // frontend/backend from source per deploy.
  const imageBase = process.env.PLATFORM_CHATBOT_IMAGE_URI;
  if (!imageBase) {
    throw new Error(
      "PLATFORM_CHATBOT_IMAGE_URI is not set. Should be the source image URI in your ECR, without a tag."
    );
  }

  const frontendImageBase = process.env.PLATFORM_FRONTEND_IMAGE_URI;
  if (!frontendImageBase) {
    throw new Error(
      "PLATFORM_FRONTEND_IMAGE_URI is not set. Should be the source chat-UI image URI in your ECR, without a tag."
    );
  }
  if (tenant.cloudProvider === "aws" && !tenant.llmSecretArn) {
    throw new Error(
      `Tenant ${tenant.id} has no llmSecretArn — the secret was not written during onboarding.`
    );
  }
  if (tenant.cloudProvider === "azure" && !tenant.llmApiKeyEncrypted) {
    throw new Error(`Tenant ${tenant.id} has no encrypted LLM key.`);
  }
  // Onboarding requires the customer's own Pinecone key whenever this store is
  // chosen, so its absence means an inconsistent tenant row. Refuse rather than
  // dispatch a deploy that would fail midway through Terraform.
  if (tenant.vectorStore === "pinecone") {
    const hasKey =
      tenant.cloudProvider === "aws"
        ? Boolean(tenant.pineconeSecretArn)
        : Boolean(tenant.pineconeApiKeyEncrypted);
    if (!hasKey) {
      throw new Error(
        `Tenant ${tenant.id} uses Pinecone but has no customer Pinecone key on file. ` +
          `Re-create the tenant and supply its own Pinecone API key, or switch it to the pgvector store.`
      );
    }
  }
  // Onboarding creates the docs-signer secret before the tenant row exists, on
  // both clouds, so a tenant without one is inconsistent rather than old.
  // Refusing here instead of generating one also means a redeploy never calls
  // STS into the customer's account: onboarding is the only time the platform
  // assumes a customer role itself.
  if (tenant.cloudProvider === "aws" && !tenant.docsSignerSecretArn) {
    throw new Error(
      `Tenant ${tenant.id} has no docsSignerSecretArn — the secret was not written during onboarding.`
    );
  }
  if (tenant.cloudProvider === "azure" && !tenant.docsSignerSecretEncrypted) {
    throw new Error(
      `Tenant ${tenant.id} has no encrypted docs-signer secret — it was not generated during onboarding.`
    );
  }

  const [deployment] = await db
    .insert(deployments)
    .values({ tenantId, chatbotVersion, triggeredByUserId, status: "pending" })
    .returning();

  const octokit = getOctokit();

  const workflowId =
    tenant.cloudProvider === "azure"
      ? "deploy-tenant-azure.yml"
      : getDeployWorkflowId();

  const inputs =
    tenant.cloudProvider === "azure"
      ? buildAzureInputs(tenant, deployment.id, chatbotVersion, imageBase, frontendImageBase)
      : buildAwsInputs(tenant, deployment.id, chatbotVersion, imageBase, frontendImageBase);

  try {
    await octokit.actions.createWorkflowDispatch({
      owner,
      repo,
      workflow_id: workflowId,
      ref,
      inputs,
    });

    await db
      .update(deployments)
      .set({ status: "running" })
      .where(eq(deployments.id, deployment.id));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db
      .update(deployments)
      .set({ status: "failed", errorMessage: message, finishedAt: new Date() })
      .where(eq(deployments.id, deployment.id));
    throw err;
  }

  return deployment;
}

type TenantRow = Awaited<ReturnType<typeof db.select>>["0"] & { cloudProvider: string };

type DestroyInput = {
  tenantId: string;
  triggeredByUserId: string;
};

/**
 * Tears down a tenant's AWS infrastructure: best-effort empties the docs
 * bucket via the docs-signer Lambda (no AWS credential needed for that —
 * force_destroy on the bucket is the backstop if this can't run), then
 * dispatches destroy-tenant.yml, which runs `terraform destroy` plus cleanup
 * for the handful of resources Terraform doesn't manage (ECR repos, the
 * platform-written secrets). Reuses the `deployments` table (kind: "destroy")
 * so this gets the same live-progress polling and reconciliation as a deploy.
 */
export async function triggerTenantDestroy({ tenantId, triggeredByUserId }: DestroyInput) {
  const [tenant] = await db.select().from(tenants).where(eq(tenants.id, tenantId));
  if (!tenant) throw new Error(`Tenant ${tenantId} not found`);
  if (tenant.cloudProvider !== "aws") {
    throw new Error("Tenant deletion is only available for AWS tenants right now.");
  }
  if (tenant.deletedAt) {
    throw new Error(`Tenant ${tenant.id} has already been deleted.`);
  }

  if (tenant.docsSignerUrl) {
    const docs = await db
      .select()
      .from(tenantDocuments)
      .where(eq(tenantDocuments.tenantId, tenant.id));

    for (const doc of docs) {
      try {
        await deleteViaSigner(tenant, doc.objectKey);
      } catch {
        // Best-effort — force_destroy on the bucket is the backstop for
        // whatever this couldn't clean up (e.g. the Lambda is unreachable).
      }
    }

    await db.delete(tenantDocuments).where(eq(tenantDocuments.tenantId, tenant.id));
  }

  const [deployment] = await db
    .insert(deployments)
    .values({
      tenantId,
      kind: "destroy",
      chatbotVersion: tenant.chatbotVersion,
      triggeredByUserId,
      status: "pending",
    })
    .returning();

  const octokit = getOctokit();
  const { owner, repo } = getChatbotRepo();
  const ref = process.env.CHATBOT_DEPLOY_REF ?? "main";

  try {
    await octokit.actions.createWorkflowDispatch({
      owner,
      repo,
      workflow_id: getDestroyWorkflowId(),
      ref,
      inputs: buildAwsDestroyInputs(tenant, deployment.id),
    });

    await db
      .update(deployments)
      .set({ status: "running" })
      .where(eq(deployments.id, deployment.id));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db
      .update(deployments)
      .set({ status: "failed", errorMessage: message, finishedAt: new Date() })
      .where(eq(deployments.id, deployment.id));
    throw err;
  }

  return deployment;
}

function buildAwsDestroyInputs(tenant: TenantRow, deploymentId: string): Record<string, string> {
  return {
    deployment_id: deploymentId,
    tenant_slug: tenant.slug,
    aws_account_id: tenant.awsAccountId!,
    aws_region: tenant.awsRegion!,
    deployment_role_arn: tenant.deploymentRoleArn!,
    chatbot_version: tenant.chatbotVersion,
    domain: tenant.domain ?? "",
    s3_docs_prefix: tenant.s3DocsPrefix ?? "",
    llm_provider: tenant.llmProvider,
    llm_secret_arn: tenant.llmSecretArn!,
    llm_model: tenant.llmModel ?? "",
    vector_store: tenant.vectorStore,
    pinecone_secret_arn: tenant.pineconeSecretArn ?? "",
    // Coalesced rather than asserted. Teardown must never be blocked by a
    // missing field: asserting non-null would drop the key from the dispatch
    // entirely, which GitHub rejects as a missing required input, leaving the
    // tenant's infrastructure impossible to remove from the platform.
    docs_signer_secret_arn: tenant.docsSignerSecretArn ?? "",
  };
}

function buildAwsInputs(
  tenant: Awaited<ReturnType<typeof db.select>>["0"] & { cloudProvider: string },
  deploymentId: string,
  chatbotVersion: string,
  imageBase: string,
  frontendImageBase: string
): Record<string, string> {
  return {
    deployment_id: deploymentId,
    tenant_slug: tenant.slug,
    aws_account_id: tenant.awsAccountId!,
    aws_region: tenant.awsRegion!,
    deployment_role_arn: tenant.deploymentRoleArn!,
    chatbot_version: chatbotVersion,
    domain: tenant.domain ?? "",
    // Always sent, including when empty. Omitting it on a redeploy would let
    // Terraform tear the HTTPS listener back down and silently return an
    // already-encrypted tenant to plain HTTP.
    acm_certificate_arn: tenant.acmCertificateArn ?? "",
    s3_docs_prefix: tenant.s3DocsPrefix ?? "",
    llm_provider: tenant.llmProvider,
    llm_secret_arn: tenant.llmSecretArn!,
    llm_model: tenant.llmModel ?? "",
    your_ecr_image: `${imageBase}:${chatbotVersion}`,
    your_frontend_ecr_image: `${frontendImageBase}:${chatbotVersion}`,
    // Like the LLM key, the customer's Pinecone key stays in their account —
    // only the ARN travels through GitHub Actions.
    vector_store: tenant.vectorStore,
    pinecone_secret_arn: tenant.pineconeSecretArn ?? "",
    docs_signer_secret_arn: tenant.docsSignerSecretArn!,
  };
}

/**
 * workflow_dispatch allows at most 10 inputs, so non-secret settings are
 * packed into a single JSON `config` input. Key names must stay in sync with
 * the "Parse tenant config" step in deploy-tenant-azure.yml.
 */
function buildAzureInputs(
  tenant: Awaited<ReturnType<typeof db.select>>["0"] & { cloudProvider: string },
  deploymentId: string,
  chatbotVersion: string,
  imageBase: string,
  frontendImageBase: string
): Record<string, string> {
  const clientSecret = tenant.azureClientSecretEncrypted
    ? decryptSecret(tenant.azureClientSecretEncrypted)
    : "";
  const llmApiKey = tenant.llmApiKeyEncrypted
    ? decryptSecret(tenant.llmApiKeyEncrypted)
    : "";
  // Azure has no pre-created secret store at dispatch time (Terraform creates
  // the Key Vault), so the customer's Pinecone key travels as a masked input
  // alongside the LLM key. Empty when the vectors stay in Postgres.
  const pineconeApiKey = tenant.pineconeApiKeyEncrypted
    ? decryptSecret(tenant.pineconeApiKeyEncrypted)
    : "";
  // Same reasoning as pineconeApiKey above: the docs-signer secret has
  // nowhere to be written until Terraform creates the Key Vault, so the
  // plaintext travels through the deploy pipeline as a masked input too
  // (see generateDocsSignerSecret in azure.ts).
  const docsSignerSecret = tenant.docsSignerSecretEncrypted
    ? decryptSecret(tenant.docsSignerSecretEncrypted)
    : "";
  return {
    deployment_id: deploymentId,
    tenant_slug: tenant.slug,
    config: JSON.stringify({
      azure_subscription_id: tenant.azureSubscriptionId!,
      azure_tenant_id: tenant.azureTenantId!,
      azure_client_id: tenant.azureClientId!,
      azure_region: tenant.azureRegion ?? "eastus",
      llm_provider: tenant.llmProvider,
      llm_model: tenant.llmModel ?? "",
      chatbot_version: chatbotVersion,
      domain: tenant.domain ?? "",
      vector_store: tenant.vectorStore,
    }),
    azure_client_secret: clientSecret,
    llm_api_key: llmApiKey,
    pinecone_api_key: pineconeApiKey,
    docs_signer_secret: docsSignerSecret,
    your_ecr_image: `${imageBase}:${chatbotVersion}`,
    your_frontend_ecr_image: `${frontendImageBase}:${chatbotVersion}`,
  };
}
