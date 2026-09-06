import "dotenv/config";
import { Pool, neonConfig } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";
import { and, eq, inArray } from "drizzle-orm";
import { tenants, deployments } from "../src/db/schema";
import ws from "ws";

neonConfig.webSocketConstructor = ws;

/**
 * Marks a tenant's stuck deployments as failed so the Redeploy button
 * re-enables (page.tsx disables it while any deploy is pending/running).
 *
 * Needed during local testing because the workflow's status callbacks POST to
 * PLATFORM_BASE_URL, which can't reach a dev server on localhost — so rows
 * stay "running" forever and the platform's own reconciliation never fires.
 *
 * Usage:
 *   npx tsx scripts/fail-stuck-deployments.ts <slug>
 */
async function main() {
  const [slug] = process.argv.slice(2);
  if (!slug) {
    console.error("Usage: npx tsx scripts/fail-stuck-deployments.ts <slug>");
    process.exit(1);
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const db = drizzle(pool);

  const [tenant] = await db.select().from(tenants).where(eq(tenants.slug, slug));
  if (!tenant) {
    console.error(`No tenant found with slug "${slug}".`);
    await pool.end();
    process.exit(1);
  }

  const updated = await db
    .update(deployments)
    .set({
      status: "failed",
      errorMessage: "Marked failed locally: status callback never reached the platform (local dev).",
      finishedAt: new Date(),
    })
    .where(
      and(eq(deployments.tenantId, tenant.id), inArray(deployments.status, ["pending", "running"])),
    )
    .returning({ id: deployments.id, startedAt: deployments.startedAt });

  console.log(`Marked ${updated.length} stuck deployment(s) as failed for "${slug}".`);
  for (const d of updated) console.log(`  ${d.id} (started ${d.startedAt?.toISOString()})`);

  await pool.end();
}

main();
