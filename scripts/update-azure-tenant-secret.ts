import "dotenv/config";
import { Pool, neonConfig } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";
import { eq } from "drizzle-orm";
import { tenants } from "../src/db/schema";
import { encryptSecret } from "../src/lib/crypto";
import ws from "ws";

neonConfig.webSocketConstructor = ws;

/**
 * One-off fix for a tenant onboarded with a bad/expired Azure client
 * secret (AADSTS7000215 at deploy time). There's no UI for this yet —
 * azureClientSecretEncrypted is only ever written during onboarding
 * (src/app/tenants/new/actions.ts).
 *
 * Usage:
 *   npx tsx scripts/update-azure-tenant-secret.ts <slug> <new-client-secret-value> [new-client-id]
 */
async function main() {
  const [slug, newSecret, newClientId] = process.argv.slice(2);

  if (!slug || !newSecret) {
    console.error(
      "Usage: npx tsx scripts/update-azure-tenant-secret.ts <slug> <new-client-secret-value> [new-client-id]",
    );
    process.exit(1);
  }
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL not set.");
    process.exit(1);
  }
  if (!process.env.PLATFORM_ENCRYPTION_KEY) {
    console.error("PLATFORM_ENCRYPTION_KEY not set.");
    process.exit(1);
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const db = drizzle(pool);

  const [existing] = await db.select().from(tenants).where(eq(tenants.slug, slug));
  if (!existing) {
    console.error(`No tenant found with slug "${slug}".`);
    await pool.end();
    process.exit(1);
  }
  if (existing.cloudProvider !== "azure") {
    console.error(`Tenant "${slug}" is cloudProvider="${existing.cloudProvider}", not "azure".`);
    await pool.end();
    process.exit(1);
  }

  const azureClientSecretEncrypted = encryptSecret(newSecret);

  await db
    .update(tenants)
    .set({
      azureClientSecretEncrypted,
      ...(newClientId ? { azureClientId: newClientId } : {}),
    })
    .where(eq(tenants.id, existing.id));

  console.log(`Updated tenant "${slug}" (id: ${existing.id}).`);
  console.log(`  azureClientSecretEncrypted: replaced`);
  if (newClientId) {
    console.log(`  azureClientId: ${existing.azureClientId} -> ${newClientId}`);
  } else {
    console.log(`  azureClientId: unchanged (${existing.azureClientId})`);
  }

  await pool.end();
}

main();
