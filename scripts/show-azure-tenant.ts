import "dotenv/config";
import { Pool, neonConfig } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";
import { eq } from "drizzle-orm";
import { tenants } from "../src/db/schema";
import ws from "ws";

neonConfig.webSocketConstructor = ws;

/**
 * Read-only lookup of an Azure tenant's stored (non-secret) identifiers,
 * to compare against `az ad app list` / `az account show` output when
 * diagnosing an AADSTS auth failure. Never prints azureClientSecretEncrypted.
 *
 * Usage:
 *   npx tsx scripts/show-azure-tenant.ts <slug>
 */
async function main() {
  const [slug] = process.argv.slice(2);

  if (!slug) {
    console.error("Usage: npx tsx scripts/show-azure-tenant.ts <slug>");
    process.exit(1);
  }
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL not set.");
    process.exit(1);
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const db = drizzle(pool);

  const [t] = await db.select().from(tenants).where(eq(tenants.slug, slug));
  if (!t) {
    console.error(`No tenant found with slug "${slug}".`);
    await pool.end();
    process.exit(1);
  }

  console.log({
    id: t.id,
    slug: t.slug,
    cloudProvider: t.cloudProvider,
    azureSubscriptionId: t.azureSubscriptionId,
    azureTenantId: t.azureTenantId,
    azureClientId: t.azureClientId,
    azureRegion: t.azureRegion,
    chatbotVersion: t.chatbotVersion,
    hasClientSecretStored: Boolean(t.azureClientSecretEncrypted),
  });

  await pool.end();
}

main();
