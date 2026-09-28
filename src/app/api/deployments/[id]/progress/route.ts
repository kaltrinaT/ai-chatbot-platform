import { NextResponse } from "next/server";
import { and, eq, inArray } from "drizzle-orm";
import { auth } from "@/auth";
import { db } from "@/db";
import { deployments, tenants } from "@/db/schema";
import {
  fetchRunProgress,
  findRunForDeployment,
  getDeployWorkflowId,
  getDestroyWorkflowId,
  type RunProgress,
} from "@/lib/github";
import { ACTIVE_STATUSES, reconcileCompletedRun } from "@/lib/reconcile";
import { AZURE_DEPLOY_WORKFLOW, AZURE_DESTROY_WORKFLOW } from "@/lib/deploy";

/**
 * Session-authed live view of a deployment. While the deployment is active it
 * also queries GitHub for run/job/step progress, and reconciles the DB row if
 * GitHub reports the run completed but the workflow's completion webhook was
 * never received (self-heals deployments stuck in "running").
 */

// A deployment still not tied to a GitHub run after this long is treated as a
// lost dispatch and failed. It must exceed the LONGEST workflow job timeout,
// which is destroy-tenant.yml at 60 minutes because it waits on CloudFront
// deletion, plus margin for a dispatched run sitting queued before its job
// starts. It was 45 minutes when every workflow timed out at 30. Raising the
// workflow timeouts without raising this would fail teardowns that are still
// legitimately running, whenever the run-started callback was lost and the run
// cannot be found by name.
const LONGEST_WORKFLOW_TIMEOUT_MS = 60 * 60_000;
const STALE_DEPLOYMENT_MS = LONGEST_WORKFLOW_TIMEOUT_MS + 15 * 60_000;
const STALE_MINUTES = STALE_DEPLOYMENT_MS / 60_000;

// Give GitHub a moment to start the run (and the early callback to land)
// before falling back to searching runs by display_title.
const RUN_LOOKUP_GRACE_MS = 60_000;

type DeploymentRow = typeof deployments.$inferSelect;

type GithubError = "run_not_found" | "github_auth" | "github_unavailable";

function serialize(d: DeploymentRow, live: RunProgress | null, extras?: {
  githubError?: GithubError | null;
  reconciled?: boolean;
}) {
  return NextResponse.json({
    deployment: {
      id: d.id,
      status: d.status,
      chatbotVersion: d.chatbotVersion,
      githubRunId: d.githubRunId,
      githubRunUrl: d.githubRunUrl,
      startedAt: d.startedAt.toISOString(),
      finishedAt: d.finishedAt?.toISOString() ?? null,
      errorMessage: d.errorMessage,
    },
    live: live
      ? {
          runStatus: live.runStatus,
          runConclusion: live.runConclusion,
          runStartedAt: live.runStartedAt,
          currentJobName: live.currentJobName,
          currentStepName: live.currentStepName,
          stepsCompleted: live.stepsCompleted,
          stepsTotal: live.stepsTotal,
        }
      : null,
    githubError: extras?.githubError ?? null,
    reconciled: extras?.reconciled ?? false,
  });
}

function classifyGithubError(err: unknown): GithubError {
  const status = (err as { status?: number }).status;
  if (status === 404) return "run_not_found";
  if (status === 401 || status === 403) return "github_auth";
  return "github_unavailable";
}

async function failStuckDeployment(id: string, message: string) {
  await db
    .update(deployments)
    .set({ status: "failed", errorMessage: message, finishedAt: new Date() })
    .where(and(eq(deployments.id, id), inArray(deployments.status, [...ACTIVE_STATUSES])));
}

async function reload(id: string): Promise<DeploymentRow> {
  const [row] = await db.select().from(deployments).where(eq(deployments.id, id));
  return row;
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  const [found] = await db
    .select({ deployment: deployments, cloudProvider: tenants.cloudProvider })
    .from(deployments)
    .innerJoin(tenants, eq(deployments.tenantId, tenants.id))
    .where(and(eq(deployments.id, id), eq(tenants.ownerUserId, session.user.id)));

  if (!found) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  let deployment = found.deployment;
  const isActive = (ACTIVE_STATUSES as readonly string[]).includes(deployment.status);
  if (!isActive) return serialize(deployment, null);

  const ageMs = Date.now() - deployment.startedAt.getTime();

  // No run ID yet: the dispatch→run-start gap, or the early callback was lost.
  if (!deployment.githubRunId) {
    if (ageMs > RUN_LOOKUP_GRACE_MS) {
      try {
        // Searching the wrong workflow silently never matches, so all four
        // combinations have to be spelled out.
        const isAzure = found.cloudProvider === "azure";
        const workflowId =
          deployment.kind === "destroy"
            ? isAzure
              ? AZURE_DESTROY_WORKFLOW
              : getDestroyWorkflowId()
            : isAzure
              ? AZURE_DEPLOY_WORKFLOW
              : getDeployWorkflowId();
        const run = await findRunForDeployment(deployment.id, deployment.startedAt, workflowId);
        if (run) {
          await db
            .update(deployments)
            .set({ githubRunId: String(run.runId), githubRunUrl: run.htmlUrl })
            .where(eq(deployments.id, deployment.id));
          deployment = await reload(deployment.id);
        }
      } catch {
        // Lookup is best-effort; fall through to the states below.
      }
    }

    if (!deployment.githubRunId) {
      if (ageMs > STALE_DEPLOYMENT_MS) {
        await failStuckDeployment(
          deployment.id,
          `No workflow run could be found for this deployment and no completion webhook arrived within ${STALE_MINUTES} minutes.`,
        );
        return serialize(await reload(deployment.id), null, { reconciled: true });
      }
      return serialize(deployment, null);
    }
  }

  try {
    const live = await fetchRunProgress(Number(deployment.githubRunId));

    if (live.runStatus === "completed") {
      await reconcileCompletedRun(deployment.id, live, Number(deployment.githubRunId));
      return serialize(await reload(deployment.id), live, { reconciled: true });
    }

    return serialize(deployment, live);
  } catch (err) {
    const githubError = classifyGithubError(err);

    // A recorded run that 404s past the stale window was deleted from GitHub;
    // auth/availability errors never auto-fail (the webhook may still arrive).
    if (githubError === "run_not_found" && ageMs > STALE_DEPLOYMENT_MS) {
      await failStuckDeployment(
        deployment.id,
        `The GitHub Actions run for this deployment no longer exists and no completion webhook arrived within ${STALE_MINUTES} minutes.`,
      );
      return serialize(await reload(deployment.id), null, { githubError, reconciled: true });
    }

    return serialize(deployment, null, { githubError });
  }
}
