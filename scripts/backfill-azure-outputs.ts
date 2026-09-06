import "dotenv/config";
import { Pool, neonConfig } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";
import { and, desc, eq, inArray } from "drizzle-orm";
import { tenants, deployments } from "../src/db/schema";
import { execFileSync } from "node:child_process";
import ws from "ws";

neonConfig.webSocketConstructor = ws;

/**
 * Recovers an Azure tenant's deploy outputs straight from Azure and marks its
 * latest deployment succeeded.
 *
 * Needed for local testing only: the workflow posts these back to
 * PLATFORM_BASE_URL, which a GitHub runner cannot reach on localhost, so the
 * tenant row keeps showing "deploying" with no chatbot or docs-signer URL even
 * though the deploy finished. Mirrors the values in
 * infra/terraform/azure/outputs.tf.
 *
 * Usage:
 *   npx tsx scripts/backfill-azure-outputs.ts <slug>
 */
// `az` is az.cmd on Windows, which Node can't spawn directly; route it through
// cmd.exe there. The output is validated by the caller rather than trusted on
// exit code alone, since the .cmd wrapper doesn't always propagate one.
function az(args: string[]): string {
  const out =
    process.platform === "win32"
      ? execFileSync(process.env.ComSpec ?? "cmd.exe", ["/c", "az", ...args], { stdio: "pipe" })
      : execFileSync("az", args, { stdio: "pipe" });
  return out.toString().trim();
}

function expectValue(value: string, mustContain: string, label: string): string {
  if (!value || !value.includes(mustContain)) {
    throw new Error(`Unexpected ${label} from az: ${JSON.stringify(value.slice(0, 200))}`);
  }
  return value;
}

async function main() {
  const [slug] = process.argv.slice(2);
  if (!slug) {
    console.error("Usage: npx tsx scripts/backfill-azure-outputs.ts <slug>");
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

  // Same naming rules as infra/terraform/azure/main.tf locals.
  const resourceGroup = `chatbot-${slug}`;
  const storageAccount = `chatbot${slug}`.replace(/-/g, "").slice(0, 24);
  const keyVaultName = `cb-${slug}-kv`;
  const functionAppName = `chatbot-${slug}-docs-signer`;

  const fqdn = expectValue(
    az([
      "containerapp", "show", "-g", resourceGroup, "-n", `chatbot-${slug}`,
      "--query", "properties.configuration.ingress.fqdn", "-o", "tsv",
    ]),
    "azurecontainerapps.io",
    "container app FQDN",
  );
  const functionHost = expectValue(
    az([
      "functionapp", "show", "-g", resourceGroup, "-n", functionAppName,
      "--query", "defaultHostName", "-o", "tsv",
    ]),
    "azurewebsites.net",
    "function app hostname",
  );

  const values = {
    chatbotUrl: tenant.domain ? `https://${tenant.domain}` : `https://${fqdn}`,
    albDnsName: fqdn,
    docsSignerUrl: `https://${functionHost}/api/docs-signer`,
    azureResourceGroup: resourceGroup,
    azureStorageAccount: storageAccount,
    azureStorageContainer: "documents",
    azureKeyVaultName: keyVaultName,
  };

  await db.update(tenants).set(values).where(eq(tenants.id, tenant.id));
  console.log(`Updated tenant "${slug}":`);
  console.log(values);

  const [latest] = await db
    .select()
    .from(deployments)
    .where(eq(deployments.tenantId, tenant.id))
    .orderBy(desc(deployments.startedAt))
    .limit(1);

  if (latest) {
    await db
      .update(deployments)
      .set({ status: "succeeded", finishedAt: new Date(), errorMessage: null })
      .where(
        and(eq(deployments.id, latest.id), inArray(deployments.status, ["pending", "running", "failed"])),
      );
    console.log(`Marked deployment ${latest.id} succeeded.`);
  }

  await pool.end();
}

main();
