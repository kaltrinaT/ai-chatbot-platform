import "dotenv/config";
import { Pool, neonConfig } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";
import { eq } from "drizzle-orm";
import { tenants } from "../src/db/schema";
import { execFileSync } from "node:child_process";
import ws from "ws";

neonConfig.webSocketConstructor = ws;

/**
 * OBSOLETE — this no longer works, and is kept only until it is removed.
 *
 * It re-added a local origin to an Azure tenant's docs storage CORS rules,
 * signing in with the storage account key. The docs account now refuses
 * Shared Key authorization (shared_access_key_enabled = false in
 * infra/terraform/azure/main.tf), so the key it fetches authorizes nothing.
 * It is also unnecessary: Terraform now adds a second origin from the
 * EXTRA_CORS_ORIGIN repository variable on every deploy. Set that variable
 * (e.g. http://localhost:3000) and redeploy the tenant instead.
 *
 * Usage:
 *   npx tsx scripts/allow-local-cors.ts <slug> [origin]
 */
function az(args: string[]): string {
  const out =
    process.platform === "win32"
      ? execFileSync(process.env.ComSpec ?? "cmd.exe", ["/c", "az", ...args], { stdio: "pipe" })
      : execFileSync("az", args, { stdio: "pipe" });
  return out.toString().trim();
}

async function main() {
  const [slug, origin = "http://localhost:3000"] = process.argv.slice(2);
  if (!slug) {
    console.error("Usage: npx tsx scripts/allow-local-cors.ts <slug> [origin]");
    process.exit(1);
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const db = drizzle(pool);
  const [tenant] = await db.select().from(tenants).where(eq(tenants.slug, slug));
  await pool.end();

  if (!tenant?.azureStorageAccount || !tenant.azureResourceGroup) {
    console.error(`Tenant "${slug}" has no Azure storage account on record.`);
    process.exit(1);
  }

  const account = tenant.azureStorageAccount;
  const key = az(["storage", "account", "keys", "list", "-g", tenant.azureResourceGroup, "-n", account, "--query", "[0].value", "-o", "tsv"]);

  const existing = az([
    "storage", "cors", "list", "--services", "b",
    "--account-name", account, "--account-key", key, "-o", "json",
  ]);
  if (existing.includes(origin)) {
    console.log(`${origin} is already allowed on ${account}.`);
    return;
  }

  az([
    "storage", "cors", "add", "--services", "b",
    "--methods", "PUT", "OPTIONS",
    "--origins", origin,
    "--allowed-headers", "*",
    "--exposed-headers", "*",
    "--max-age", "3000",
    "--account-name", account, "--account-key", key,
  ]);
  console.log(`Added ${origin} to ${account}'s blob CORS rules.`);
}

main();
