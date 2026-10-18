import { describe, it, expect } from "vitest";
import { getTableColumns } from "drizzle-orm";
import { tenants } from "@/db/schema";
import { deletedTenantUpdate } from "./tenantErasure";

// Attack matrix — secret storage, deleted tenant. A deleted tenant's row is
// kept for the audit trail, so whatever stays in it outlives the customer.
describe("deletedTenantUpdate", () => {
  // Read from the schema rather than listed here, so a secret column added
  // later fails this test until the erasure covers it too.
  const encryptedColumns = Object.keys(getTableColumns(tenants)).filter((c) => c.endsWith("Encrypted"));

  it("finds the stored secrets to check", () => {
    expect(encryptedColumns).toEqual(
      expect.arrayContaining(["llmApiKeyEncrypted", "pineconeApiKeyEncrypted", "docsSignerSecretEncrypted"]),
    );
  });

  it("nulls every encrypted column on the tenants table", () => {
    const update = deletedTenantUpdate() as Record<string, unknown>;
    for (const column of encryptedColumns) {
      expect(update, column).toHaveProperty(column, null);
    }
  });

  // The platform sends the docs-signer secret to this address. Once the
  // function is destroyed, its name can be claimed by someone else.
  it("forgets the address the docs-signer secret was sent to", () => {
    expect(deletedTenantUpdate()).toHaveProperty("docsSignerUrl", null);
  });

  it("marks the row deleted, which every tenant action's query excludes", () => {
    const now = new Date("2026-10-18T12:00:00Z");
    expect(deletedTenantUpdate(now)).toMatchObject({ deletedAt: now, updatedAt: now });
  });
});
