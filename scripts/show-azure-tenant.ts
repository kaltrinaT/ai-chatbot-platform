import "dotenv/config";
import { Pool, neonConfig } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";
import { eq } from "drizzle-orm";
import { tenants } from "../src/db/schema";
import { findChatbotRepo } from "../src/lib/github";
import { azureFederatedSubject } from "../src/lib/azureFederation";
import ws from "ws";

neonConfig.webSocketConstructor = ws;

/**
 * Read-only lookup of an Azure tenant's identifiers and the federated subject
 * its identity must trust, to compare against
 * `az ad app federated-credential list --id <client-id>` when diagnosing an
 * AADSTS login failure (AADSTS70021/700213: no matching federated credential).
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
    federatedSubject: (() => {
      const repo = findChatbotRepo();
      return repo ? azureFederatedSubject(repo, t.id) : "(CHATBOT_REPO_OWNER / CHATBOT_REPO_NAME not set)";
    })(),
  });

  await pool.end();
}

main();
