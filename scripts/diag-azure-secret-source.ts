import "dotenv/config";
import { Pool, neonConfig } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";
import { eq } from "drizzle-orm";
import { tenants } from "../src/db/schema";
import { decryptSecret } from "../src/lib/crypto";
import ws from "ws";

neonConfig.webSocketConstructor = ws;

/**
 * Diagnostic for "every Azure tenant's client secret looks like an LLM key".
 *
 * Answers one question: is the stored azureClientSecret byte-identical to the
 * stored llmApiKey? If it is, the same string reached both columns — either
 * pasted into both boxes, or copied between them somewhere in the onboarding
 * path. If it isn't, the Azure column got its value from somewhere else.
 *
 * Prints only lengths, 4-character prefixes and an equality flag — never a
 * secret's contents.
 *
 * Usage:
 *   npx tsx scripts/diag-azure-secret-source.ts [slug]
 */
function describe(label: string, encrypted: string | null) {
  if (!encrypted) return `${label}: (none stored)`;
  try {
    const v = decryptSecret(encrypted);
    const trailing = v !== v.trim() ? " TRAILING-WHITESPACE" : "";
    return `${label}: len=${v.length} starts="${v.slice(0, 4)}"${trailing}`;
  } catch (e) {
    return `${label}: DECRYPT FAILED — ${(e as Error).message}`;
  }
}

async function main() {
  const [slugFilter] = process.argv.slice(2);

  if (!process.env.DATABASE_URL || !process.env.PLATFORM_ENCRYPTION_KEY) {
    console.error("DATABASE_URL and PLATFORM_ENCRYPTION_KEY must be set.");
    process.exit(1);
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const db = drizzle(pool);

  const rows = await db.select().from(tenants).where(eq(tenants.cloudProvider, "azure"));

  for (const t of rows) {
    if (slugFilter && t.slug !== slugFilter) continue;

    let same: boolean | null = null;
    if (t.azureClientSecretEncrypted && t.llmApiKeyEncrypted) {
      try {
        same = decryptSecret(t.azureClientSecretEncrypted) === decryptSecret(t.llmApiKeyEncrypted);
      } catch {
        same = null;
      }
    }

    console.log(
      [
        `${t.slug}  (created ${t.createdAt?.toISOString() ?? "?"})`,
        `    ${describe("azureClientSecret", t.azureClientSecretEncrypted)}`,
        `    ${describe("llmApiKey        ", t.llmApiKeyEncrypted)}`,
        `    llmProvider=${t.llmProvider}  identical=${same === null ? "?" : same ? "YES" : "no"}`,
      ].join("\n"),
    );
  }

  await pool.end();
}

main();
