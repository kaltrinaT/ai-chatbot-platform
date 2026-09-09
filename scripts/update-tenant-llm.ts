import "dotenv/config";
import { Pool, neonConfig } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";
import { eq } from "drizzle-orm";
import { tenants } from "../src/db/schema";
import { encryptSecret } from "../src/lib/crypto";
import ws from "ws";

neonConfig.webSocketConstructor = ws;

const PROVIDERS = ["openai", "anthropic", "openrouter"] as const;
type Provider = (typeof PROVIDERS)[number];

/**
 * Swaps the LLM credentials of an existing tenant. Onboarding is the only
 * other place these are written (src/app/tenants/new/actions.ts), so without
 * this a rotated or rate-limited key means re-onboarding the tenant.
 *
 * The tenant must be redeployed afterwards: Terraform writes the key into
 * the tenant's own secret store and passes the model/provider as container
 * env, so nothing changes at runtime until the next deploy.
 *
 * The key can be passed as an argument or, to keep it out of shell history,
 * via the LLM_API_KEY environment variable.
 *
 * Usage:
 *   npx tsx scripts/update-tenant-llm.ts <slug> [key] [--model=<model>] [--provider=<provider>]
 */
async function main() {
  const args = process.argv.slice(2);
  const slug = args.find((a) => !a.startsWith("--"));
  const positionalKey = args.filter((a) => !a.startsWith("--"))[1];
  const key = process.env.LLM_API_KEY ?? positionalKey;
  const model = args.find((a) => a.startsWith("--model="))?.split("=").slice(1).join("=");
  const provider = args.find((a) => a.startsWith("--provider="))?.split("=")[1] as Provider | undefined;

  if (!slug) {
    console.error(
      "Usage: npx tsx scripts/update-tenant-llm.ts <slug> [key] [--model=<model>] [--provider=<provider>]",
    );
    process.exit(1);
  }
  if (provider && !PROVIDERS.includes(provider)) {
    console.error(`provider must be one of: ${PROVIDERS.join(", ")}`);
    process.exit(1);
  }
  if (!key && !model && !provider) {
    console.error("Nothing to change — pass a key, --model, or --provider.");
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

  await db
    .update(tenants)
    .set({
      ...(key ? { llmApiKeyEncrypted: encryptSecret(key) } : {}),
      ...(model ? { llmModel: model } : {}),
      ...(provider ? { llmProvider: provider } : {}),
    })
    .where(eq(tenants.id, tenant.id));

  console.log(`Updated tenant "${slug}" (${tenant.id}):`);
  if (key) console.log("  llmApiKeyEncrypted: replaced");
  if (provider) console.log(`  llmProvider: ${tenant.llmProvider} -> ${provider}`);
  if (model) console.log(`  llmModel: ${tenant.llmModel || "(provider default)"} -> ${model}`);
  console.log("\nRedeploy the tenant for this to reach the running chatbot.");

  await pool.end();
}

main();
