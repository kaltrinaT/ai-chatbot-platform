import type { tenants } from "@/db/schema";

/**
 * What a tenant row becomes once its teardown has succeeded.
 *
 * The row itself stays, soft-deleted: its deployments, who triggered them and
 * which account or subscription they went into are the platform's audit
 * trail, and none of that is a credential. The credentials go. Nothing can
 * use them any more — the docs-signer they authenticated is destroyed, a
 * deleted tenant can never be redeployed, and a returning customer onboards
 * as a new tenant and enters their keys again — so keeping them would only
 * leave every former customer's keys one leaked PLATFORM_ENCRYPTION_KEY away
 * from recovery. This mirrors the AWS teardown, which force-deletes the
 * customer-side copies in Secrets Manager.
 *
 * Applied only on a *succeeded* destroy, never when one is requested: the
 * Azure teardown needs the Pinecone key to delete the index, so clearing it
 * any earlier would make a failed teardown impossible to retry. Both places
 * that record a successful destroy — the status webhook and the reconcile
 * path for a lost webhook — use this, so neither can leave secrets behind.
 */
export function deletedTenantUpdate(now: Date = new Date()) {
  return {
    deletedAt: now,
    updatedAt: now,
    llmApiKeyEncrypted: null,
    pineconeApiKeyEncrypted: null,
    docsSignerSecretEncrypted: null,
    // The address those secrets were sent to; it now names a deleted endpoint.
    docsSignerUrl: null,
  } satisfies Partial<typeof tenants.$inferInsert>;
}
