import "dotenv/config";
import { Pool, neonConfig } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";
import { eq } from "drizzle-orm";
import { tenants } from "../src/db/schema";
import { decryptSecret } from "../src/lib/crypto";
import ws from "ws";

neonConfig.webSocketConstructor = ws;

/**
 * End-to-end check of a tenant's docs-signer (presign -> upload -> delete),
 * driven the same way the platform's own server actions drive it.
 *
 * Usage:
 *   npx tsx scripts/test-docs-signer.ts <slug>
 */
async function main() {
  const [slug] = process.argv.slice(2);
  if (!slug) {
    console.error("Usage: npx tsx scripts/test-docs-signer.ts <slug>");
    process.exit(1);
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const db = drizzle(pool);
  const [t] = await db.select().from(tenants).where(eq(tenants.slug, slug));
  if (!t?.docsSignerUrl || !t.docsSignerSecretEncrypted) {
    console.error("Tenant missing docsSignerUrl or docsSignerSecretEncrypted.");
    await pool.end();
    process.exit(1);
  }

  const secret = decryptSecret(t.docsSignerSecretEncrypted);
  const call = (body: unknown) =>
    fetch(t.docsSignerUrl!, {
      method: "POST",
      headers: { "content-type": "application/json", "x-docs-signer-secret": secret },
      body: JSON.stringify(body),
    });

  console.log("1. presign-upload ...");
  const presignRes = await call({
    action: "presign-upload",
    fileName: "docs-signer-smoke-test.txt",
    contentType: "text/plain",
    sizeBytes: 24,
  });
  const presignText = await presignRes.text();
  console.log(`   status ${presignRes.status}`);
  if (!presignRes.ok) {
    console.log(`   body: ${presignText.slice(0, 400)}`);
    await pool.end();
    process.exit(1);
  }
  const { objectKey, url } = JSON.parse(presignText) as { objectKey: string; url: string };
  console.log(`   objectKey: ${objectKey}`);
  console.log(`   sas host:  ${new URL(url).host}`);

  console.log("2. PUT the blob with the SAS ...");
  const putRes = await fetch(url, {
    method: "PUT",
    headers: { "x-ms-blob-type": "BlockBlob", "content-type": "text/plain" },
    body: "docs-signer smoke test\n",
  });
  console.log(`   status ${putRes.status}`);
  if (!putRes.ok) console.log(`   body: ${(await putRes.text()).slice(0, 400)}`);

  console.log("3. unauthenticated call should be rejected ...");
  const unauth = await fetch(t.docsSignerUrl, {
    method: "POST",
    headers: { "content-type": "application/json", "x-docs-signer-secret": "wrong" },
    body: JSON.stringify({ action: "presign-upload", fileName: "x.txt", contentType: "text/plain", sizeBytes: 1 }),
  });
  console.log(`   status ${unauth.status} (expect 401)`);

  console.log("4. delete ...");
  const delRes = await call({ action: "delete", objectKey });
  console.log(`   status ${delRes.status}`);
  if (!delRes.ok) console.log(`   body: ${(await delRes.text()).slice(0, 400)}`);

  await pool.end();
}

main();
