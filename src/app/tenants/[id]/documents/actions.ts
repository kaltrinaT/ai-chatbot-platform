"use server";

import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
import { auth } from "@/auth";
import { db } from "@/db";
import { tenants, tenantDocuments } from "@/db/schema";
import { presignUpload, deleteViaSigner } from "@/lib/docsSigner";
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
    .where(and(eq(tenants.id, tenantId), eq(tenants.ownerUserId, userId)));

  if (!tenant) throw new Error("Tenant not found");
  return tenant;
}

/**
 * Requests a presigned upload URL from the tenant's own docs-signer Lambda
 * and records a "pending" row so the document shows up in the list
 * immediately. The platform never sees or stores the file's bytes — the
 * browser POSTs directly to S3 using the fields returned here.
 */
export async function requestUploadUrl(
  tenantId: string,
  fileName: string,
  contentType: string,
  sizeBytes: number,
) {
  const userId = await requireSessionUserId();
  const tenant = await requireOwnedTenant(tenantId, userId);
  if (!tenant.docsSignerUrl) {
    throw new Error("Documents aren't available yet — wait for the first deploy to finish.");
  }

  const presigned = await presignUpload(tenant, { fileName, contentType, sizeBytes });

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

  return { documentId: doc.id, url: presigned.url, fields: presigned.fields };
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
 * Called by the browser after the direct-to-S3 upload succeeds. Marks the
 * document uploaded and (per the auto-trigger decision) immediately kicks
 * off a reindex — note this is a full resync of every document under the
 * tenant's prefix, not just this one (see triggerReindex).
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
 * Deletes a document from S3 (via the docs-signer Lambda, which does the
 * delete itself using its own narrow credentials) and from the platform's
 * own record. Note: this does not remove the document's already-embedded
 * vectors — the chatbot backend's /api/index only upserts, it never purges.
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
