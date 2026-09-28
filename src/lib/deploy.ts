import { db } from "@/db";
import { deployments, tenants, tenantDocuments } from "@/db/schema";
import { eq } from "drizzle-orm";
import { getChatbotRepo, getDeployWorkflowId, getDestroyWorkflowId, getOctokit } from "@/lib/github";
import { deleteViaSigner } from "@/lib/docsSigner";

// Azure has no operator override for these the way AWS does (see
// getDeployWorkflowId / getDestroyWorkflowId): the workflow names are part of
// the platform's own repository layout, and deployPipeline.test.ts reads both
// files by name to check their security properties.
export const AZURE_DEPLOY_WORKFLOW = "deploy-tenant-azure.yml";
export const AZURE_DESTROY_WORKFLOW = "destroy-tenant-azure.yml";

/** The ref every deploy and teardown is dispatched on. */
export function deployRef(): string {
  return process.env.CHATBOT_DEPLOY_REF ?? "main";
}

/** Another deploy or teardown for this tenant is still pending or running. */
export class DeploymentInProgressError extends Error {
  constructor(tenantId: string) {
    super(
      `A deployment for tenant ${tenantId} is already in progress. Wait for it to finish before starting another.`,
    );
    this.name = "DeploymentInProgressError";
  }
}

const ONE_ACTIVE_INDEX = "deployments_one_active_per_tenant";

/** Postgres's unique violation on that index, however the driver wraps it. */
function isActiveDeploymentConflict(err: unknown): boolean {
  for (let e = err as { code?: string; constraint?: string; message?: string; cause?: unknown } | undefined;
    e;
    e = e.cause as typeof e) {
    if (e.code === "23505" && `${e.constraint ?? ""} ${e.message ?? ""}`.includes(ONE_ACTIVE_INDEX)) {
      return true;
    }
  }
  return false;
}

/**
 * Creates the deployment row, which is also what claims the tenant's single
 * in-flight slot. The database refuses a second active row for one tenant
 * (see deployments_one_active_per_tenant in schema.ts), so two requests racing
 * each other cannot both get here: the loser gets DeploymentInProgressError,
 * before anything has been dispatched or touched.
 */
async function claimDeployment(values: typeof deployments.$inferInsert) {
  try {
    const [deployment] = await db.insert(deployments).values(values).returning();
    return deployment;
  } catch (err) {
    if (isActiveDeploymentConflict(err)) throw new DeploymentInProgressError(values.tenantId);
    throw err;
  }
}

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
  const ref = deployRef();

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

  const deployment = await claimDeployment({
    tenantId,
    chatbotVersion,
    triggeredByUserId,
    status: "pending",
  });

  const octokit = getOctokit();

  const workflowId =
    tenant.cloudProvider === "azure" ? AZURE_DEPLOY_WORKFLOW : getDeployWorkflowId();

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
 * Tears down a tenant's infrastructure on either cloud: best-effort empties
 * the documents store through the tenant's own docs-signer (no cloud
 * credential needed for that — force_destroy on the AWS bucket, and the
 * workflow's own delete-batch on Azure, are the backstops if this can't run),
 * then dispatches the cloud's destroy workflow, which runs `terraform destroy`
 * plus cleanup for the handful of resources Terraform doesn't manage.
 *
 * Reuses the `deployments` table (kind: "destroy") so this gets the same
 * live-progress polling and reconciliation as a deploy.
 *
 * Neither teardown removes the identity the customer created during
 * onboarding, on either cloud: a deploy's credentials are that identity, so
 * destroying it mid-run would be sawing through the branch. Removing it is the
 * customer's own revocation step — deleting the CloudFormation stack, or the
 * Azure resource group — and the workflows say so when they finish.
 */
export async function triggerTenantDestroy({ tenantId, triggeredByUserId }: DestroyInput) {
  const [tenant] = await db.select().from(tenants).where(eq(tenants.id, tenantId));
  if (!tenant) throw new Error(`Tenant ${tenantId} not found`);
  if (tenant.deletedAt) {
    throw new Error(`Tenant ${tenant.id} has already been deleted.`);
  }

  // Claimed before any document is touched, so a teardown refused because a
  // deploy is still running has deleted nothing.
  const deployment = await claimDeployment({
    tenantId,
    kind: "destroy",
    chatbotVersion: tenant.chatbotVersion,
    triggeredByUserId,
    status: "pending",
  });

  if (tenant.docsSignerUrl) {
    const docs = await db
      .select()
      .from(tenantDocuments)
      .where(eq(tenantDocuments.tenantId, tenant.id));

    for (const doc of docs) {
      try {
        await deleteViaSigner(tenant, doc.objectKey);
        // Only once the object is really gone, so if the dispatch below
        // fails, the document list still shows what storage still holds.
        await db.delete(tenantDocuments).where(eq(tenantDocuments.id, doc.id));
      } catch {
        // Best-effort — force_destroy on the bucket is the backstop for
        // whatever this couldn't clean up (e.g. the Lambda is unreachable).
      }
    }
  }

  const octokit = getOctokit();
  const { owner, repo } = getChatbotRepo();
  const ref = deployRef();

  try {
    await octokit.actions.createWorkflowDispatch({
      owner,
      repo,
      workflow_id:
        tenant.cloudProvider === "azure" ? AZURE_DESTROY_WORKFLOW : getDestroyWorkflowId(),
      ref,
      inputs:
        tenant.cloudProvider === "azure"
          ? buildAzureDestroyInputs(tenant, deployment.id)
          : buildAwsDestroyInputs(tenant, deployment.id),
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
    // Names the GitHub environment the teardown runs in, and so the subject
    // the customer's role federates on — the same binding a deploy uses.
    // Teardown must carry it too, or a customer could never remove a tenant.
    tenant_id: tenant.id,
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

/**
 * Teardown's counterpart to buildAzureInputs: the same packed `config` blob,
 * minus everything only a deploy needs.
 *
 * No secret travels here. The Pinecone key a teardown needs (destroying the
 * index calls Pinecone's own API, which an Azure token does not cover) is
 * fetched by the run itself — see src/lib/deploymentSecrets.ts.
 */
function buildAzureDestroyInputs(tenant: TenantRow, deploymentId: string): Record<string, string> {
  return {
    deployment_id: deploymentId,
    tenant_id: tenant.id,
    tenant_slug: tenant.slug,
    config: JSON.stringify({
      azure_subscription_id: tenant.azureSubscriptionId!,
      azure_tenant_id: tenant.azureTenantId!,
      azure_client_id: tenant.azureClientId!,
      azure_region: tenant.azureRegion ?? "eastus",
      llm_provider: tenant.llmProvider,
      llm_model: tenant.llmModel ?? "",
      domain: tenant.domain ?? "",
      vector_store: tenant.vectorStore,
    }),
  };
}

/**
 * The tenant's retrieval relevance floor, if one has been set.
 *
 * A chunk whose cosine similarity to the question falls below this is dropped
 * before the prompt is built, so a gate set too high makes the chatbot answer
 * "I don't have enough information" to everything — the container shipped a
 * hard-coded 0.5 for a while, which no real document could clear. There is no
 * column and no wizard field for it: it is a tuning knob a handful of tenants
 * will ever need, so it lives in the free-form `config` blob, and an unset
 * value means the container's own calibrated default applies.
 *
 * Anything unparseable is ignored rather than thrown on. A bad value in a
 * hand-edited JSON blob should not be able to block a deployment, and the
 * consequence of ignoring it — the container default — is the safe outcome.
 */
export function retrievalMinScore(config: Record<string, unknown> | null): string {
  const raw = config?.retrieval_min_score;
  if (raw === undefined || raw === null || raw === "") return "";

  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    console.warn(
      `[deploy] ignoring config.retrieval_min_score=${JSON.stringify(raw)} — ` +
        `expected a number between 0 and 1`,
    );
    return "";
  }
  return String(value);
}

/** Whether AWS tenants are fronted by CloudFront. See enable_cdn below. */
function cdnEnabled(): boolean {
  const configured = process.env.PLATFORM_ENABLE_CDN?.trim().toLowerCase();
  return configured !== "false" && configured !== "0" && configured !== "off";
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
    // Binds this run to one tenant's role: it names the GitHub environment the
    // job runs in, which is what GitHub writes into the OIDC token's subject
    // and what the customer's trust policy matches on. Both clouds bind the
    // same way now — see src/lib/githubOidc.ts.
    tenant_id: tenant.id,
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
    // On by default, since it is what gives a tenant without a certificate any
    // HTTPS at all. Overridable because an AWS account that has not been
    // verified for CloudFront cannot create a distribution, and the deploy
    // fails on it: those tenants have to be served by the load balancer alone,
    // which means plain HTTP until they bring a certificate.
    enable_cdn: cdnEnabled() ? "true" : "false",
    s3_docs_prefix: tenant.s3DocsPrefix ?? "",
    llm_provider: tenant.llmProvider,
    llm_secret_arn: tenant.llmSecretArn!,
    llm_model: tenant.llmModel ?? "",
    retrieval_min_score: retrievalMinScore(tenant.config),
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
 *
 * No credential of any kind is among them. The workflow logs in to the
 * customer's subscription through the federated credential they created,
 * which trusts the GitHub environment named after `tenant_id` (see
 * azureFederation.ts). The tenant's application secrets — LLM key, Pinecone
 * key, docs-signer secret — are not inputs either, since GitHub records inputs
 * in the run's event payload: the run fetches them from the platform with its
 * own OIDC token (see src/lib/deploymentSecrets.ts).
 */
function buildAzureInputs(
  tenant: Awaited<ReturnType<typeof db.select>>["0"] & { cloudProvider: string },
  deploymentId: string,
  chatbotVersion: string,
  imageBase: string,
  frontendImageBase: string
): Record<string, string> {
  return {
    deployment_id: deploymentId,
    tenant_id: tenant.id,
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
      retrieval_min_score: retrievalMinScore(tenant.config),
    }),
    your_ecr_image: `${imageBase}:${chatbotVersion}`,
    your_frontend_ecr_image: `${frontendImageBase}:${chatbotVersion}`,
  };
}
