import { NextResponse } from "next/server";
import { and, eq, inArray } from "drizzle-orm";
import { auth } from "@/auth";
import { db } from "@/db";
import { deployments, tenants } from "@/db/schema";
import { fetchRunProgress, findRunForDeployment, type RunProgress } from "@/lib/github";

/**
 * Session-authed live view of a deployment. While the deployment is active it
 * also queries GitHub for run/job/step progress, and reconciles the DB row if
 * GitHub reports the run completed but the workflow's completion webhook was
 * never received (self-heals deployments stuck in "running").
 */

const ACTIVE_STATUSES = ["pending", "running"] as const;

// Past the workflow's own 30-minute timeout; if we still can't tie the row to
// a run by then, the dispatch was lost and the deployment can never finish.
const STALE_DEPLOYMENT_MS = 45 * 60_000;

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

/**
 * GitHub says the run completed but our row is still active — the completion
 * webhook was lost. Flip the row to the mapped terminal status. The write is
 * guarded on status so a concurrently-arriving real webhook wins.
 *
 * Deliberately does NOT touch tenants.chatbotUrl/albDnsName: Terraform outputs
 * aren't in run metadata, and the control-plane boundary forbids fetching them
 * from the customer's account. For redeploys this is lossless (in-place, URL
 * unchanged); after a lost first-deploy success callback the URL fills in on
 * the next successful deploy.
 */
async function reconcileCompletedRun(id: string, live: RunProgress) {
  const status =
    live.runConclusion === "success"
      ? ("succeeded" as const)
      : live.runConclusion === "cancelled"
        ? ("cancelled" as const)
        : ("failed" as const);

  await db
    .update(deployments)
    .set({
      status,
      finishedAt: new Date(live.updatedAt),
      ...(status === "succeeded"
        ? {}
        : {
            errorMessage: `Reconciled from GitHub: run concluded '${live.runConclusion ?? "unknown"}'; the completion webhook was not received. See the run logs.`,
          }),
    })
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
    .select({ deployment: deployments })
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
        const run = await findRunForDeployment(deployment.id, deployment.startedAt);
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
          "No workflow run could be found for this deployment and no completion webhook arrived within 45 minutes.",
        );
        return serialize(await reload(deployment.id), null, { reconciled: true });
      }
      return serialize(deployment, null);
    }
  }

  try {
    const live = await fetchRunProgress(Number(deployment.githubRunId));

    if (live.runStatus === "completed") {
      await reconcileCompletedRun(deployment.id, live);
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
        "The GitHub Actions run for this deployment no longer exists and no completion webhook arrived within 45 minutes.",
      );
      return serialize(await reload(deployment.id), null, { githubError, reconciled: true });
    }

    return serialize(deployment, null, { githubError });
  }
}
