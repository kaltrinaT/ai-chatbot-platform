import { Octokit } from "@octokit/rest";
import { db } from "@/db";
import { deployments, tenants } from "@/db/schema";
import { eq } from "drizzle-orm";

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

  const [deployment] = await db
    .insert(deployments)
    .values({
      tenantId,
      chatbotVersion,
      triggeredByUserId,
      status: "pending",
    })
    .returning();

  const owner = process.env.CHATBOT_REPO_OWNER!;
  const repo = process.env.CHATBOT_REPO_NAME!;
  const workflowId = process.env.CHATBOT_DEPLOY_WORKFLOW ?? "deploy-tenant.yml";
  const ref = process.env.CHATBOT_DEPLOY_REF ?? "main";

  const octokit = new Octokit({ auth: process.env.GITHUB_PAT! });

  try {
    await octokit.actions.createWorkflowDispatch({
      owner,
      repo,
      workflow_id: workflowId,
      ref,
      inputs: {
        deployment_id: deployment.id,
        tenant_slug: tenant.slug,
        aws_account_id: tenant.awsAccountId,
        aws_region: tenant.awsRegion,
        deployment_role_arn: tenant.deploymentRoleArn,
        chatbot_version: chatbotVersion,
        domain: tenant.domain ?? "",
      },
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
