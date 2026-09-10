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
 * driven the same way the platform's own server actions drive it. Handles
 * both clouds: AWS answers a presign with S3 presigned-POST fields the upload
 * has to be a multipart POST of, Azure with a single SAS URL to PUT to.
 *
 * This is the way to see what the signer actually said — the platform's own
 * UI only ever shows a summary, and a thrown Server Function error is
 * redacted by React before it reaches the browser at all.
 *
 * Usage:
 *   npx tsx scripts/test-docs-signer.ts <slug|tenant-id> [--presign-only]
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function main() {
  const args = process.argv.slice(2);
  const presignOnly = args.includes("--presign-only");
  const [ref] = args.filter((a) => !a.startsWith("--"));
  if (!ref) {
    console.error("Usage: npx tsx scripts/test-docs-signer.ts <slug|tenant-id> [--presign-only]");
    process.exit(1);
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const db = drizzle(pool);
  // A tenant id is what the dashboard URL carries, so accept either that or
  // the slug rather than making the caller go look the other one up.
  const [t] = await db
    .select()
    .from(tenants)
    .where(UUID_RE.test(ref) ? eq(tenants.id, ref) : eq(tenants.slug, ref));
  if (!t) {
    console.error(`No tenant matches ${ref}.`);
    await pool.end();
    process.exit(1);
  }
  console.log(`tenant ${t.slug} (${t.cloudProvider})`);
  if (!t.docsSignerUrl || !t.docsSignerSecretEncrypted) {
    console.error(
      `Tenant is missing ${!t.docsSignerUrl ? "docsSignerUrl" : "docsSignerSecretEncrypted"}.`,
    );
    await pool.end();
    process.exit(1);
  }

  // Decryption is the first thing the platform does on every documents call,
  // and it fails outright when PLATFORM_ENCRYPTION_KEY here is not the key
  // this row was encrypted with — worth naming rather than stack-tracing.
  let secret: string;
  try {
    secret = decryptSecret(t.docsSignerSecretEncrypted);
  } catch (err) {
    console.error(
      "Could not decrypt docsSignerSecretEncrypted with this PLATFORM_ENCRYPTION_KEY:",
      err instanceof Error ? err.message : err,
    );
    await pool.end();
    process.exit(1);
  }
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
  const { objectKey, url, fields } = JSON.parse(presignText) as {
    objectKey: string;
    url: string;
    fields?: Record<string, string>;
  };
  console.log(`   objectKey:   ${objectKey}`);
  console.log(`   upload host: ${new URL(url).host}`);
  console.log(`   protocol:    ${fields ? "S3 presigned POST" : "Azure Blob SAS PUT"}`);

  if (presignOnly) {
    console.log("--presign-only: stopping before writing anything.");
    await pool.end();
    return;
  }

  console.log("2. upload the test object ...");
  const body = "docs-signer smoke test\n";
  let putRes: Response;
  if (fields) {
    // Mirrors UploadDocumentForm.tsx: policy fields first, bytes last.
    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) form.append(key, value);
    form.append("file", new Blob([body], { type: "text/plain" }));
    putRes = await fetch(url, { method: "POST", body: form });
  } else {
    putRes = await fetch(url, {
      method: "PUT",
      headers: { "x-ms-blob-type": "BlockBlob", "content-type": "text/plain" },
      body,
    });
  }
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
