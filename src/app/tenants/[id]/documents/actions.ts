"use server";

import { revalidatePath } from "next/cache";
import { and, eq, isNull } from "drizzle-orm";
import { auth } from "@/auth";
import { db } from "@/db";
import { tenants, tenantDocuments } from "@/db/schema";
import { presignUpload, deleteViaSigner, DocsSignerError } from "@/lib/docsSigner";
import { triggerReindex } from "@/lib/reindex";

async function requireSessionUserId(): Promise<string> {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Not authenticated");
  return session.user.id;
}

async function requireOwnedTenant(tenantId: string, userId: string) {
  const [tenant] = await db
    .select()
    .from(tenants)
    .where(
      and(eq(tenants.id, tenantId), eq(tenants.ownerUserId, userId), isNull(tenants.deletedAt)),
    );

  if (!tenant) throw new Error("Tenant not found");
  return tenant;
}

/**
 * Why this returns a failure instead of throwing one: a Server Function that
 * throws reaches the browser as React's redacted placeholder ("An error
 * occurred in the Server Components render…"), which tells a tenant owner
 * nothing about which of the many things behind an upload link actually
 * broke. Per Next's error-handling guide, expected failures are modelled as
 * return values; only genuine bugs are left to throw.
 */
export type UploadUrlResult =
  | { ok: true; documentId: string; url: string; fields?: Record<string, string> }
  | { ok: false; error: string };

/**
 * Turns a presign failure into something the tenant owner can act on. The
 * signer's own 4xx bodies are safe to pass through — they describe the file
 * the caller just chose, and carry neither the signer URL nor the shared
 * secret. Anything else is deliberately NOT forwarded: an unexpected error
 * (a driver error carrying a connection string, say) stays in the server log.
 */
function describePresignFailure(err: unknown): string {
  if (err instanceof DocsSignerError) {
    // The handler answers 401 for a bad secret and never 403, so a 403 comes
    // from the cloud in front of it rejecting the call before the handler
    // runs — on AWS, a Function URL with no resource-based policy allowing
    // lambda:InvokeFunctionUrl. No secret the platform holds can fix that.
    if (err.status === 403) {
      return (
        `The tenant's cloud refused to invoke the docs-signer at all (403), before its own ` +
        `authentication ran. The function's invoke permission is missing — redeploy the tenant.`
      );
    }
    if (err.status === 401) {
      return (
        `The tenant's docs-signer rejected the platform's credentials (401). ` +
        `The shared secret the platform holds no longer matches the one the function checks against — ` +
        `redeploying the tenant reissues both halves.`
      );
    }
    if (err.status === 400) {
      return `The tenant's docs-signer refused this file: ${err.reason || "no reason given"}.`;
    }
    return `The tenant's docs-signer returned ${err.status}${err.reason ? `: ${err.reason}` : ""}.`;
  }

  // AbortSignal.timeout rejects with a TimeoutError; a cold Lambda that has to
  // fetch its secret from Secrets Manager is the usual way to spend 10s.
  if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
    return "The tenant's docs-signer didn't respond within 10 seconds. Try the upload again.";
  }

  if (err instanceof Error && err.message.includes("deploy has not completed")) {
    return err.message;
  }

  return "Couldn't reach the tenant's docs-signer. The platform's server log has the reason.";
}

/**
 * Requests a presigned upload URL from the tenant's own docs-signer function
 * (an AWS Lambda or an Azure Function, depending on cloudProvider) and
 * records a "pending" row so the document shows up in the list immediately.
 * The platform never sees or stores the file's bytes — the browser uploads
 * directly to the tenant's own cloud storage using what's returned here
 * (see UploadDocumentForm.tsx for the two upload protocols).
 */
export async function requestUploadUrl(
  tenantId: string,
  fileName: string,
  contentType: string,
  sizeBytes: number,
): Promise<UploadUrlResult> {
  const session = await auth();
  if (!session?.user?.id) {
    return { ok: false, error: "Your session has expired. Sign in again and retry the upload." };
  }
  const userId = session.user.id;

  const [tenant] = await db
    .select()
    .from(tenants)
    .where(
      and(eq(tenants.id, tenantId), eq(tenants.ownerUserId, userId), isNull(tenants.deletedAt)),
    );

  if (!tenant) return { ok: false, error: "Tenant not found." };
  if (!tenant.docsSignerUrl) {
    return {
      ok: false,
      error: "Documents aren't available yet — wait for the first deploy to finish.",
    };
  }

  let presigned;
  try {
    presigned = await presignUpload(tenant, { fileName, contentType, sizeBytes });
  } catch (err) {
    // The only place the real cause is recorded — everything above returns a
    // summary, so without this line a production failure leaves no trace.
    console.error(
      `[requestUploadUrl] presign failed for tenant ${tenant.id} ` +
        `(${fileName}, ${contentType}, ${sizeBytes} bytes)`,
      err,
    );
    return { ok: false, error: describePresignFailure(err) };
  }

  const [doc] = await db
    .insert(tenantDocuments)
    .values({
      tenantId: tenant.id,
      objectKey: presigned.objectKey,
      displayName: fileName,
      contentType,
      sizeBytes,
      status: "pending",
      uploadedByUserId: userId,
    })
    .returning();

  return { ok: true, documentId: doc.id, url: presigned.url, fields: presigned.fields };
}

async function requireOwnedDocument(documentId: string) {
  const userId = await requireSessionUserId();

  const [doc] = await db
    .select()
    .from(tenantDocuments)
    .where(eq(tenantDocuments.id, documentId));
  if (!doc) throw new Error("Document not found");

  const tenant = await requireOwnedTenant(doc.tenantId, userId);
  return { doc, tenant };
}

/**
 * Called by the browser after the direct-to-cloud-storage upload succeeds.
 * Marks the document uploaded and (per the auto-trigger decision)
 * immediately kicks off a reindex — note this is a full resync of every
 * document under the tenant's prefix, not just this one (see triggerReindex).
 */
export async function confirmUpload(documentId: string) {
  const { doc, tenant } = await requireOwnedDocument(documentId);

  await db
    .update(tenantDocuments)
    .set({ status: "uploaded", updatedAt: new Date() })
    .where(eq(tenantDocuments.id, doc.id));

  const reindex = await triggerReindex(tenant);
  revalidatePath(`/tenants/${tenant.id}`);

  return reindex.ok
    ? { ok: true as const }
    : { ok: false as const, warning: `Uploaded, but reindexing failed: ${reindex.error}` };
}

/**
 * Called by the browser when the direct-to-cloud-storage upload fails, so a
 * document the tenant never actually received doesn't linger in the list.
 * Only ever removes a row still awaiting its upload — the status guard means
 * a confirmUpload that landed first always wins.
 *
 * No storage cleanup is needed or possible here: the upload failed, so
 * there's nothing to delete, and the platform can't check either way (it has
 * no read or list permission on the tenant's documents).
 */
export async function abandonUpload(documentId: string) {
  const { doc, tenant } = await requireOwnedDocument(documentId);

  await db
    .delete(tenantDocuments)
    .where(and(eq(tenantDocuments.id, doc.id), eq(tenantDocuments.status, "pending")));

  revalidatePath(`/tenants/${tenant.id}`);
}

/**
 * Deletes a document from cloud storage (via the docs-signer function,
 * which does the delete itself using its own narrowly-scoped credentials)
 * and from the platform's own record. Note: this does not remove the
 * document's already-embedded vectors — the chatbot backend's /api/index
 * only upserts, it never purges.
 */
export async function deleteDocument(documentId: string) {
  const { doc, tenant } = await requireOwnedDocument(documentId);

  await deleteViaSigner(tenant, doc.objectKey);
  await db.delete(tenantDocuments).where(eq(tenantDocuments.id, doc.id));

  const reindex = await triggerReindex(tenant);
  revalidatePath(`/tenants/${tenant.id}`);

  return reindex.ok
    ? { ok: true as const }
    : { ok: false as const, warning: `Deleted, but reindexing failed: ${reindex.error}` };
}
