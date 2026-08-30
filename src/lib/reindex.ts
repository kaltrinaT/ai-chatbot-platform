import type { tenants } from "@/db/schema";

type Tenant = typeof tenants.$inferSelect;

/**
 * Triggers the tenant's own chatbot backend to (re)load documents from S3
 * into its vector store. Per CHATBOT-LOGIC.md, POST /api/index does a full
 * resync of everything under the prefix — it does not incrementally embed
 * just the changed document, and it never removes vectors for a document
 * that's been deleted from S3. Both are limitations of the external
 * ai-chatbot/ai-backend repo, not something this call can control.
 */
export async function triggerReindex(
  tenant: Pick<Tenant, "slug" | "chatbotUrl" | "s3DocsBucket" | "s3DocsPrefix">,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!tenant.chatbotUrl) {
    return { ok: false, error: "Tenant has no chatbotUrl yet — deploy has not completed." };
  }

  try {
    const res = await fetch(`${tenant.chatbotUrl}/api/index`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        tenant_id: tenant.slug,
        bucket: tenant.s3DocsBucket,
        prefix: tenant.s3DocsPrefix ?? "",
      }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) {
      return { ok: false, error: `Reindex endpoint returned ${res.status}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
