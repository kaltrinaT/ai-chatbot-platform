import "dotenv/config";
import { Pool, neonConfig } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";
import { eq } from "drizzle-orm";
import { tenants } from "../src/db/schema";
import { getChatbotRepo } from "../src/lib/github";
import { azureFederatedSubject } from "../src/lib/azureFederation";
import ws from "ws";

neonConfig.webSocketConstructor = ws;

/**
 * Points an Azure tenant at a different deployment identity, for a tenant
 * onboarded with the wrong client ID (AADSTS700016 at deploy time) or a
 * customer who replaced their identity. There's no UI for this yet.
 *
 * There is no secret to rotate: the new identity needs a federated credential
 * with the subject this prints, and the next redeploy uses it.
 *
 * Usage:
 *   npx tsx scripts/update-azure-tenant-identity.ts <slug> <new-client-id>
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function main() {
  const [slug, newClientId] = process.argv.slice(2);

  if (!slug || !newClientId) {
    console.error("Usage: npx tsx scripts/update-azure-tenant-identity.ts <slug> <new-client-id>");
    process.exit(1);
  }
  if (!UUID_RE.test(newClientId)) {
    console.error(`"${newClientId}" is not a client ID. Expected a UUID.`);
    process.exit(1);
  }
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL not set.");
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

  await db.update(tenants).set({ azureClientId: newClientId }).where(eq(tenants.id, existing.id));

  console.log(`Updated tenant "${slug}" (id: ${existing.id}).`);
  console.log(`  azureClientId: ${existing.azureClientId} -> ${newClientId}`);
  console.log(`  The new identity needs a federated credential with subject:`);
  console.log(`    ${azureFederatedSubject(getChatbotRepo(), existing.id)}`);

  await pool.end();
}

main();
