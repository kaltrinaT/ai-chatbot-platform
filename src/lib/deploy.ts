import { Octokit } from "@octokit/rest";
import { db } from "@/db";
import { deployments, tenants } from "@/db/schema";
import { eq } from "drizzle-orm";
import { decryptSecret } from "@/lib/crypto";

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

  const owner = process.env.CHATBOT_REPO_OWNER!;
  const repo = process.env.CHATBOT_REPO_NAME!;
  const ref = process.env.CHATBOT_DEPLOY_REF ?? "main";

  const imageBase = process.env.PLATFORM_CHATBOT_IMAGE_URI;
  if (!imageBase) {
    throw new Error(
      "PLATFORM_CHATBOT_IMAGE_URI is not set. Should be the source image URI in your ECR, without a tag."
    );
  }
  if (!tenant.llmSecretArn) {
    throw new Error(
      `Tenant ${tenant.id} has no llmSecretArn — the secret was not written during onboarding.`
    );
  }

  const [deployment] = await db
    .insert(deployments)
    .values({ tenantId, chatbotVersion, triggeredByUserId, status: "pending" })
    .returning();

  const octokit = new Octokit({ auth: process.env.GITHUB_PAT! });

  const workflowId =
    tenant.cloudProvider === "azure"
      ? "deploy-tenant-azure.yml"
      : (process.env.CHATBOT_DEPLOY_WORKFLOW ?? "deploy-tenant.yml");

  const inputs =
    tenant.cloudProvider === "azure"
      ? buildAzureInputs(tenant, deployment.id, chatbotVersion, imageBase)
      : buildAwsInputs(tenant, deployment.id, chatbotVersion, imageBase);

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
  imageBase: string
): Record<string, string> {
  return {
    deployment_id: deploymentId,
    tenant_slug: tenant.slug,
    aws_account_id: tenant.awsAccountId!,
    aws_region: tenant.awsRegion!,
    deployment_role_arn: tenant.deploymentRoleArn!,
    chatbot_version: chatbotVersion,
    domain: tenant.domain ?? "",
    s3_docs_bucket: tenant.s3DocsBucket!,
    s3_docs_prefix: tenant.s3DocsPrefix ?? "",
    llm_provider: tenant.llmProvider,
    llm_secret_arn: tenant.llmSecretArn!,
    your_ecr_image: `${imageBase}:${chatbotVersion}`,
  };
}

function buildAzureInputs(
  tenant: Awaited<ReturnType<typeof db.select>>["0"] & { cloudProvider: string },
  deploymentId: string,
  chatbotVersion: string,
  imageBase: string
): Record<string, string> {
  const clientSecret = tenant.azureClientSecretEncrypted
    ? decryptSecret(tenant.azureClientSecretEncrypted)
    : "";

  return {
    deployment_id: deploymentId,
    tenant_slug: tenant.slug,
    azure_subscription_id: tenant.azureSubscriptionId!,
    azure_tenant_id: tenant.azureTenantId!,
    azure_client_id: tenant.azureClientId!,
    azure_client_secret: clientSecret,
    azure_region: tenant.azureRegion ?? "eastus",
    azure_storage_account: tenant.azureStorageAccount!,
    azure_storage_container: tenant.azureStorageContainer ?? "",
    llm_provider: tenant.llmProvider,
    llm_key_vault_uri: tenant.llmSecretArn!,
    chatbot_version: chatbotVersion,
    domain: tenant.domain ?? "",
    source_ecr_image: `${imageBase}:${chatbotVersion}`,
  };
}
