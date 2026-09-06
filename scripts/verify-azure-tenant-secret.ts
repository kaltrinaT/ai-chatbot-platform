import "dotenv/config";
import { Pool, neonConfig } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";
import { eq } from "drizzle-orm";
import { tenants } from "../src/db/schema";
import { decryptSecret } from "../src/lib/crypto";
import ws from "ws";

neonConfig.webSocketConstructor = ws;

/**
 * Verifies each Azure tenant's stored client secret by doing the same
 * client_credentials token request azure/login performs internally.
 *
 * Deliberately does NOT shell out to `az login` — on Windows the az.cmd
 * wrapper does not propagate exit codes, so a failed login is
 * indistinguishable from a successful one.
 *
 * Usage:
 *   npx tsx scripts/verify-azure-tenant-secret.ts [slug]
 */
async function verify(tenantId: string, clientId: string, secret: string) {
  const res = await fetch(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: secret,
      scope: "https://management.azure.com/.default",
      grant_type: "client_credentials",
    }),
  });
  if (res.ok) return { ok: true as const };
  const body = (await res.json().catch(() => ({}))) as { error_description?: string };
  return { ok: false as const, error: (body.error_description ?? "").split("\r\n")[0] };
}

async function main() {
  const [slugFilter] = process.argv.slice(2);
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const db = drizzle(pool);

  const rows = await db.select().from(tenants).where(eq(tenants.cloudProvider, "azure"));
  for (const t of rows) {
    if (slugFilter && t.slug !== slugFilter) continue;
    let secret: string;
    try {
      secret = decryptSecret(t.azureClientSecretEncrypted!);
    } catch (e) {
      console.log(`${t.slug}: DECRYPT FAILED — ${(e as Error).message}`);
      continue;
    }
    const result = await verify(t.azureTenantId!, t.azureClientId!, secret);
    console.log(
      `${t.slug}: ${result.ok ? "VALID" : "INVALID"} (len=${secret.length}, starts="${secret.slice(0, 4)}")` +
        (result.ok ? "" : `\n    ${result.error}`),
    );
  }

  await pool.end();
}

main();
