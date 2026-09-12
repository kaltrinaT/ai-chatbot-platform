import "dotenv/config";
import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "../src/db";
import { deployments, tenants } from "../src/db/schema";
import {
  fetchRunProgress,
  findRunForDeployment,
  getDeployWorkflowId,
  getDestroyWorkflowId,
} from "../src/lib/github";
import { ACTIVE_STATUSES, reconcileCompletedRun } from "../src/lib/reconcile";

/**
 * Repairs deployments stuck on "pending"/"running" after their workflow
 * actually finished, using the same reconcile the progress endpoint runs.
 *
 * That endpoint is pull-based, so it only heals a deployment somebody had
 * open in a browser while it completed. A deployment whose completion webhook
 * was lost AND that nobody was watching stays active forever, including past
 * the staleness cutoff (STALE_DEPLOYMENT_MS in the progress route), because
 * that cutoff lives behind the same poll. This script is the out-of-band way to
 * close those.
 *
 * Usage:
 *   npx tsx scripts/reconcile-deployment.ts            # every stuck row
 *   npx tsx scripts/reconcile-deployment.ts <slug>     # one tenant's rows
 *   npx tsx scripts/reconcile-deployment.ts --dry-run
 */
async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const [slug] = args.filter((a) => !a.startsWith("--"));

  const rows = await db
    .select({ deployment: deployments, slug: tenants.slug, cloudProvider: tenants.cloudProvider })
    .from(deployments)
    .innerJoin(tenants, eq(deployments.tenantId, tenants.id))
    .where(
      slug
        ? and(inArray(deployments.status, [...ACTIVE_STATUSES]), eq(tenants.slug, slug))
        : inArray(deployments.status, [...ACTIVE_STATUSES]),
    )
    .orderBy(desc(deployments.startedAt));

  if (rows.length === 0) {
    console.log("No active deployments to reconcile.");
    return;
  }

  console.log(`${rows.length} active deployment(s)${dryRun ? " (dry run)" : ""}\n`);

  for (const { deployment, slug: tenantSlug, cloudProvider } of rows) {
    const age = Math.round((Date.now() - deployment.startedAt.getTime()) / 60_000);
    console.log(`${tenantSlug} ${deployment.kind} ${deployment.id}  (${age}m old)`);

    // The run id is missing exactly when the run-started callback was lost
    // too, which is the common case here — recover it by display_title the
    // same way the progress endpoint does.
    let runId = deployment.githubRunId ? Number(deployment.githubRunId) : null;
    if (!runId) {
      const workflowId =
        deployment.kind === "destroy"
          ? getDestroyWorkflowId()
          : cloudProvider === "azure"
            ? "deploy-tenant-azure.yml"
            : getDeployWorkflowId();
      const run = await findRunForDeployment(deployment.id, deployment.startedAt, workflowId);
      if (!run) {
        console.log(`   no workflow run found in ${workflowId}; leaving as-is\n`);
        continue;
      }
      runId = run.runId;
      console.log(`   recovered run ${runId}`);
      if (!dryRun) {
        await db
          .update(deployments)
          .set({ githubRunId: String(run.runId), githubRunUrl: run.htmlUrl })
          .where(eq(deployments.id, deployment.id));
      }
    }

    const live = await fetchRunProgress(runId);
    if (live.runStatus !== "completed") {
      console.log(`   run is still ${live.runStatus}; leaving as-is\n`);
      continue;
    }

    console.log(`   run concluded '${live.runConclusion}'`);
    if (dryRun) {
      console.log("   dry run — not writing\n");
      continue;
    }

    await reconcileCompletedRun(deployment.id, live, runId);
    const [after] = await db
      .select()
      .from(deployments)
      .where(eq(deployments.id, deployment.id));
    console.log(`   status is now '${after.status}'\n`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
