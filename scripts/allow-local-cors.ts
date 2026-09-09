import "dotenv/config";
import { Pool, neonConfig } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";
import { eq } from "drizzle-orm";
import { tenants } from "../src/db/schema";
import { execFileSync } from "node:child_process";
import ws from "ws";

neonConfig.webSocketConstructor = ws;

/**
 * Re-adds a local origin to an Azure tenant's docs storage CORS rules.
 *
 * Terraform builds that rule from platform_origin (the PLATFORM_BASE_URL
 * secret) alone, so every deploy wipes any extra origin — including the one
 * a dev server browses from. Without it the browser's preflight is rejected
 * and uploads fail before the SAS is ever used.
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
