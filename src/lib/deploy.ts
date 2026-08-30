import { db } from "@/db";
import { deployments, tenants } from "@/db/schema";
import { eq } from "drizzle-orm";
import { decryptSecret } from "@/lib/crypto";
import { getChatbotRepo, getDeployWorkflowId, getOctokit } from "@/lib/github";
import { ensureDocsSignerSecret } from "@/lib/aws";

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
  let [tenant] = await db.select().from(tenants).where(eq(tenants.id, tenantId));
  if (!tenant) throw new Error(`Tenant ${tenantId} not found`);

  const { owner, repo } = getChatbotRepo();
  const ref = process.env.CHATBOT_DEPLOY_REF ?? "main";

  // AWS replicates prebuilt images from the platform ECR; Azure builds from
  // source in the workflow, so the image URIs are only required for AWS.
  const imageBase = process.env.PLATFORM_CHATBOT_IMAGE_URI;
  if (tenant.cloudProvider === "aws" && !imageBase) {
    throw new Error(
      "PLATFORM_CHATBOT_IMAGE_URI is not set. Should be the source image URI in your ECR, without a tag."
    );
  }

  const frontendImageBase = process.env.PLATFORM_FRONTEND_IMAGE_URI;
  if (tenant.cloudProvider === "aws" && !frontendImageBase) {
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
  // Tenants onboarded before the vector-store choice existed have no customer
  // Pinecone key on file — they ran against the platform's shared index, which
  // no longer exists. They must be re-onboarded rather than silently redeployed.
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
  if (tenant.cloudProvider === "aws" && !tenant.docsSignerSecretArn) {
    // Tenants onboarded before the docs-signer feature shipped have no
    // secret on file yet — generate and store it lazily on their next
    // deploy rather than requiring a manual DB backfill.
    const docsSigner = await ensureDocsSignerSecret({
      roleArn: tenant.deploymentRoleArn!,
      region: tenant.awsRegion!,
      slug: tenant.slug,
      sessionName: `tenant-redeploy-docs-${tenant.slug}`,
    });
    await db
      .update(tenants)
      .set({
        docsSignerSecretArn: docsSigner.docsSignerSecretArn,
        docsSignerSecretEncrypted: docsSigner.docsSignerSecretEncrypted,
        updatedAt: new Date(),
      })
      .where(eq(tenants.id, tenant.id));
    tenant = {
      ...tenant,
      docsSignerSecretArn: docsSigner.docsSignerSecretArn,
      docsSignerSecretEncrypted: docsSigner.docsSignerSecretEncrypted,
    };
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
      ? buildAzureInputs(tenant, deployment.id, chatbotVersion)
      : buildAwsInputs(tenant, deployment.id, chatbotVersion, imageBase!, frontendImageBase!);

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
  chatbotVersion: string
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
  };
}
