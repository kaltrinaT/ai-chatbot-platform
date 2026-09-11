import type { tenants } from "@/db/schema";

type Tenant = typeof tenants.$inferSelect;

/**
 * The tenant's document bucket.
 *
 * `tenants.s3DocsBucket` exists in the schema but nothing ever writes to it —
 * not onboarding, not the deployment webhook, not the reconcile path — so it
 * is null for every tenant. The name is deterministic anyway: Terraform
 * creates `chatbot-${var.tenant_slug}-docs` (infra/terraform/main.tf), and the
 * tenant page has always derived it that way.
 *
 * Deriving it here too is what stops a reindex posting `"bucket": null` to the
 * chatbot backend, which answers 500.
 */
export function docsBucketName(tenant: Pick<Tenant, "slug" | "s3DocsBucket">): string {
  return tenant.s3DocsBucket ?? `chatbot-${tenant.slug}-docs`;
}

// Indexing is synchronous over HTTP and scales with the number of documents
// under the prefix, since /api/index resyncs all of them rather than just the
// one that changed. Kept below the tenant ALB's idle timeout (180s, see
// aws_lb.this) so the caller is what gives up rather than the proxy.
const REINDEX_TIMEOUT_MS = 120_000;

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
        bucket: docsBucketName(tenant),
        prefix: tenant.s3DocsPrefix ?? "",
      }),
      signal: AbortSignal.timeout(REINDEX_TIMEOUT_MS),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      return {
        ok: false,
        error: `Reindex endpoint returned ${res.status}${detail ? `: ${detail.slice(0, 300)}` : ""}`,
      };
    }
    return { ok: true };
  } catch (err) {
    console.error(`[triggerReindex] ${tenant.slug} -> ${tenant.chatbotUrl}/api/index failed`, err);
    return { ok: false, error: describeFetchFailure(err) };
  }
}

/**
 * Node's fetch reports every transport-level problem as the single word
 * "fetch failed" and hides the reason in `cause`, which the caller used to
 * throw away. A DNS failure, a refused connection, a reset mid-upload and an
 * aborted request all looked identical, and none of them said anything.
 */
function describeFetchFailure(err: unknown): string {
  if (!(err instanceof Error)) return String(err);

  // AbortSignal.timeout fires this, and it is worth naming separately: the
  // request was fine, the backend was just slower than we allow.
  if (err.name === "TimeoutError") {
    return `Reindex did not finish within ${REINDEX_TIMEOUT_MS / 1000}s. It may still be running.`;
  }
  if (err.name === "AbortError") {
    return "Reindex request was aborted before it completed.";
  }

  const cause = err.cause as { code?: string; message?: string } | undefined;
  const code = cause?.code;
  if (code) {
    return `Could not reach the chatbot backend (${code}).`;
  }
  const detail = cause?.message ?? err.message;
  return `Could not reach the chatbot backend: ${detail}`;
}
