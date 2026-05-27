import "dotenv/config";
import { Pool, neonConfig } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";
import { tenants } from "../src/db/schema";
import ws from "ws";

neonConfig.webSocketConstructor = ws;

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL not set.");
    process.exit(1);
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const db = drizzle(pool);

  const slug = "diag-" + Date.now();
  console.log("Attempting insert with slug:", slug);

  try {
    const [t] = await db
      .insert(tenants)
      .values({
        name: "Diag Test",
        slug,
        ownerUserId: "c1a7e9f5-3cc4-47f8-a427-5e3c7e8ed8c4",
        awsAccountId: "229647349798",
        awsRegion: "us-east-1",
        deploymentRoleArn: "arn:aws:iam::229647349798:role/chatbot-client-deploy-test",
        s3DocsBucket: "diag-bucket",
        llmProvider: "openai",
        llmApiKeyEncrypted: "iv:tag:ciphertext",
      })
      .returning();
    console.log("SUCCESS — inserted row id:", t.id);
  } catch (err) {
    console.error("FAILED. Bare error follows:");
    console.error(err);
    if (err && typeof err === "object" && "cause" in err) {
      console.error("Cause:");
      console.error((err as { cause: unknown }).cause);
    }
  }

  await pool.end();
}

main();
