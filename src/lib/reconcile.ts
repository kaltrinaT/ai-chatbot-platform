import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { deployments, tenants } from "@/db/schema";
import { fetchDeploymentOutputsArtifact, type RunProgress } from "@/lib/github";

/**
 * Statuses a deployment can still move away from. A write guarded on these
 * means a real webhook arriving concurrently always wins over a reconcile.
 */
export const ACTIVE_STATUSES = ["pending", "running"] as const;

/**
 * GitHub says the run completed but our row is still active — the completion
 * webhook was lost. Flip the row to the mapped terminal status.
 *
 * For a successful deploy, also best-effort recovers tenants.chatbotUrl /
 * albDnsName / docsSignerUrl from the "Upload deployment outputs" artifact
 * the workflow uploads right after `terraform apply`. This stays within the
 * platform's own CI (an artifact it already has read access to), not the
 * customer's cloud account, so it doesn't cross the control-plane boundary.
 * Redundant-but-harmless when the direct webhook already landed (same
 * values); the only cost of a lost webhook is one extra API call instead of
 * a permanently-missing URL.
 *
 * tenants.deletedAt is the destroy equivalent — unlike a URL, it needs no
 * output value from the run, just "now()", so a lost success webhook for a
 * destroy doesn't leave the tenant stuck looking un-deleted after its infra
 * is gone.
 *
 * Lives here rather than in the progress route because it is not really a
 * property of that endpoint: the same repair has to be runnable from
 * scripts/reconcile-deployment.ts for a deployment nobody had open in a
 * browser while it finished.
 */
export async function reconcileCompletedRun(
  id: string,
  live: RunProgress,
  runId: number,
): Promise<void> {
  const status =
    live.runConclusion === "success"
      ? ("succeeded" as const)
      : live.runConclusion === "cancelled"
        ? ("cancelled" as const)
        : ("failed" as const);

  const [updated] = await db
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
    .where(and(eq(deployments.id, id), inArray(deployments.status, [...ACTIVE_STATUSES])))
    .returning();

  if (updated && status === "succeeded" && updated.kind === "destroy") {
    await db
      .update(tenants)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(eq(tenants.id, updated.tenantId));
  } else if (updated && status === "succeeded" && updated.kind === "deploy") {
    try {
      const outputs = await fetchDeploymentOutputsArtifact(runId);
      if (outputs?.chatbotUrl || outputs?.albDnsName || outputs?.docsSignerUrl) {
        await db
          .update(tenants)
          .set({
            ...(outputs.chatbotUrl ? { chatbotUrl: outputs.chatbotUrl } : {}),
            ...(outputs.albDnsName ? { albDnsName: outputs.albDnsName } : {}),
            ...(outputs.docsSignerUrl ? { docsSignerUrl: outputs.docsSignerUrl } : {}),
            updatedAt: new Date(),
          })
          .where(eq(tenants.id, updated.tenantId));
      }
    } catch {
      // Best-effort recovery only — the deployment is still correctly marked
      // succeeded even if the artifact is missing, expired or unreadable.
    }
  }
}
