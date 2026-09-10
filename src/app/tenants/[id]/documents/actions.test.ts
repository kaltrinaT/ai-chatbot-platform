import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  selectWhereChain,
  insertValuesReturningChain,
  updateSetWhereChain,
  deleteWhereChain,
} from "@/test/db-chains";

const {
  authMock,
  dbSelectWhere,
  dbInsertReturning,
  dbUpdateWhere,
  dbDeleteWhere,
  presignUpload,
  deleteViaSigner,
  triggerReindex,
  revalidatePath,
} = vi.hoisted(() => ({
  authMock: vi.fn(),
  dbSelectWhere: vi.fn(),
  dbInsertReturning: vi.fn(),
  dbUpdateWhere: vi.fn(),
  dbDeleteWhere: vi.fn(),
  presignUpload: vi.fn(),
  deleteViaSigner: vi.fn(),
  triggerReindex: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock("@/auth", () => ({ auth: authMock }));
vi.mock("@/db", () => ({
  db: {
    select: vi.fn(() => selectWhereChain(dbSelectWhere)),
    insert: vi.fn(() => insertValuesReturningChain(dbInsertReturning)),
    update: vi.fn(() => updateSetWhereChain(dbUpdateWhere)),
    delete: vi.fn(() => deleteWhereChain(dbDeleteWhere)),
  },
}));
// Stubs the two calls, but keeps the real DocsSignerError — the action
// branches on `instanceof`, so a stubbed-out class would make every signer
// failure look like an unexpected one.
vi.mock("@/lib/docsSigner", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/docsSigner")>()),
  presignUpload,
  deleteViaSigner,
}));
vi.mock("@/lib/reindex", () => ({ triggerReindex }));
vi.mock("next/cache", () => ({ revalidatePath }));

import { db } from "@/db";
import { tenantDocuments } from "@/db/schema";
import { DocsSignerError } from "@/lib/docsSigner";
import { requestUploadUrl, confirmUpload, abandonUpload, deleteDocument } from "./actions";

const tenantRow = {
  id: "tenant-1",
  ownerUserId: "user-1",
  chatbotUrl: "http://chatbot.example.com",
  docsSignerUrl: "https://abc.lambda-url.us-east-1.on.aws/",
  docsSignerSecretEncrypted: "iv:tag:ct",
};

const docRow = {
  id: "doc-1",
  tenantId: "tenant-1",
  objectKey: "docs/uuid-file.pdf",
  displayName: "file.pdf",
  status: "uploaded",
};

describe("requestUploadUrl", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The action logs the real cause of a presign failure; keep that out of
    // the test output while still exercising the path that writes it.
    vi.spyOn(console, "error").mockImplementation(() => {});
    authMock.mockResolvedValue({ user: { id: "user-1" } });
    dbSelectWhere.mockResolvedValue([tenantRow]);
    presignUpload.mockResolvedValue({
      objectKey: "docs/uuid-file.pdf",
      url: "https://s3.amazonaws.com/bucket",
      fields: { key: "docs/uuid-file.pdf" },
    });
    dbInsertReturning.mockResolvedValue([{ id: "doc-1" }]);
  });

  // Every failure below is RETURNED, not thrown: a thrown Server Function
  // error reaches the browser as React's redacted placeholder, which would
  // put the tenant owner right back where this bug started.
  it("returns a failure when there is no authenticated session", async () => {
    authMock.mockResolvedValue(null);

    const result = await requestUploadUrl("tenant-1", "file.pdf", "application/pdf", 1024);

    expect(result).toEqual({ ok: false, error: expect.stringMatching(/session has expired/i) });
    expect(presignUpload).not.toHaveBeenCalled();
  });

  it("returns 'Tenant not found' when the query returns nothing (wrong owner or missing tenant)", async () => {
    dbSelectWhere.mockResolvedValue([]);

    const result = await requestUploadUrl("tenant-1", "file.pdf", "application/pdf", 1024);

    expect(result).toEqual({ ok: false, error: "Tenant not found." });
    expect(presignUpload).not.toHaveBeenCalled();
  });

  it("returns a failure when the tenant has no docsSignerUrl yet (deploy not finished)", async () => {
    dbSelectWhere.mockResolvedValue([{ ...tenantRow, docsSignerUrl: null }]);

    const result = await requestUploadUrl("tenant-1", "file.pdf", "application/pdf", 1024);

    expect(result).toEqual({ ok: false, error: expect.stringMatching(/aren't available yet/) });
    expect(presignUpload).not.toHaveBeenCalled();
  });

  it("presigns the upload and inserts a pending tenant_documents row", async () => {
    const result = await requestUploadUrl("tenant-1", "file.pdf", "application/pdf", 1024);

    expect(presignUpload).toHaveBeenCalledWith(tenantRow, {
      fileName: "file.pdf",
      contentType: "application/pdf",
      sizeBytes: 1024,
    });
    expect(result).toEqual({
      ok: true,
      documentId: "doc-1",
      url: "https://s3.amazonaws.com/bucket",
      fields: { key: "docs/uuid-file.pdf" },
    });
  });

  it("surfaces the signer's own reason for a 400, unwrapped from its JSON body", async () => {
    presignUpload.mockRejectedValue(
      new DocsSignerError(400, '{"error":"unsupported content type: application/octet-stream"}'),
    );

    const result = await requestUploadUrl("tenant-1", "notes.md", "application/octet-stream", 12);

    expect(result).toEqual({
      ok: false,
      error:
        "The tenant's docs-signer refused this file: unsupported content type: application/octet-stream.",
    });
    // No pending row for an upload that was never authorised.
    expect(db.insert).not.toHaveBeenCalled();
  });

  // A Lambda Function URL with no resource-based policy answers 403 with this
  // body, before the handler's own secret check runs. Reporting it as a
  // credential problem would send the reader after the wrong thing entirely.
  it("distinguishes a 403 from the cloud from the signer's own 401", async () => {
    presignUpload.mockRejectedValue(
      new DocsSignerError(403, '{"Message":"Forbidden. For troubleshooting Function URL authorization issues, see: https://docs.aws.amazon.com/lambda/latest/dg/urls-auth.html"}'),
    );

    const result = await requestUploadUrl("tenant-1", "file.pdf", "application/pdf", 1024);

    expect(result).toMatchObject({ ok: false });
    const { error } = result as { error: string };
    expect(error).toMatch(/invoke permission is missing/i);
    expect(error).not.toMatch(/shared secret/i);
  });

  it("explains a 401 as a shared-secret mismatch rather than repeating the status", async () => {
    presignUpload.mockRejectedValue(new DocsSignerError(401, '{"error":"unauthorized"}'));

    const result = await requestUploadUrl("tenant-1", "file.pdf", "application/pdf", 1024);

    expect(result).toMatchObject({ ok: false });
    expect((result as { error: string }).error).toMatch(/shared secret/i);
  });

  it("does not forward an unexpected error's message to the browser", async () => {
    presignUpload.mockRejectedValue(new Error("connect ECONNREFUSED 10.0.0.1:5432"));

    const result = await requestUploadUrl("tenant-1", "file.pdf", "application/pdf", 1024);

    expect(result).toMatchObject({ ok: false });
    expect((result as { error: string }).error).not.toContain("ECONNREFUSED");
  });

  it("records the uploader and the object key minted by the signer, with pending status", async () => {
    await requestUploadUrl("tenant-1", "file.pdf", "application/pdf", 1024);

    // insertValuesReturningChain gives each db.insert() call its own fresh
    // `.values` mock — read back what this call passed to it.
    const valuesCall = (db.insert as ReturnType<typeof vi.fn>).mock.results[0].value.values;
    expect(valuesCall).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: "tenant-1",
        objectKey: "docs/uuid-file.pdf",
        displayName: "file.pdf",
        contentType: "application/pdf",
        sizeBytes: 1024,
        status: "pending",
        uploadedByUserId: "user-1",
      }),
    );
  });
});

describe("confirmUpload", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authMock.mockResolvedValue({ user: { id: "user-1" } });
    dbSelectWhere.mockResolvedValueOnce([docRow]).mockResolvedValueOnce([tenantRow]);
    dbUpdateWhere.mockResolvedValue(undefined);
    triggerReindex.mockResolvedValue({ ok: true });
  });

  it("throws 'Document not found' when the document row does not exist", async () => {
    dbSelectWhere.mockReset();
    dbSelectWhere.mockResolvedValueOnce([]);

    await expect(confirmUpload("doc-1")).rejects.toThrow("Document not found");
  });

  it("throws 'Tenant not found' when the document's tenant isn't owned by the caller", async () => {
    dbSelectWhere.mockReset();
    dbSelectWhere.mockResolvedValueOnce([docRow]).mockResolvedValueOnce([]);

    await expect(confirmUpload("doc-1")).rejects.toThrow("Tenant not found");
  });

  it("marks the document uploaded and triggers a reindex", async () => {
    const result = await confirmUpload("doc-1");

    expect(dbUpdateWhere).toHaveBeenCalled();
    expect(triggerReindex).toHaveBeenCalledWith(tenantRow);
    expect(revalidatePath).toHaveBeenCalledWith("/tenants/tenant-1");
    expect(result).toEqual({ ok: true });
  });

  it("returns a warning (not a thrown error) when the upload succeeded but reindexing failed", async () => {
    triggerReindex.mockResolvedValue({ ok: false, error: "backend unreachable" });

    const result = await confirmUpload("doc-1");

    expect(result).toEqual({
      ok: false,
      warning: "Uploaded, but reindexing failed: backend unreachable",
    });
    // The document is still marked uploaded even though reindexing failed.
    expect(dbUpdateWhere).toHaveBeenCalled();
  });
});

describe("abandonUpload", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authMock.mockResolvedValue({ user: { id: "user-1" } });
    dbSelectWhere.mockResolvedValueOnce([docRow]).mockResolvedValueOnce([tenantRow]);
    dbDeleteWhere.mockResolvedValue(undefined);
  });

  it("throws 'Document not found' when the document row does not exist", async () => {
    dbSelectWhere.mockReset();
    dbSelectWhere.mockResolvedValueOnce([]);

    await expect(abandonUpload("doc-1")).rejects.toThrow("Document not found");
    expect(dbDeleteWhere).not.toHaveBeenCalled();
  });

  it("throws 'Tenant not found' when the caller does not own the document's tenant", async () => {
    dbSelectWhere.mockReset();
    dbSelectWhere.mockResolvedValueOnce([docRow]).mockResolvedValueOnce([]);

    await expect(abandonUpload("doc-1")).rejects.toThrow("Tenant not found");
    expect(dbDeleteWhere).not.toHaveBeenCalled();
  });

  it("deletes the row from tenantDocuments and revalidates the tenant page", async () => {
    await abandonUpload("doc-1");

    expect(db.delete).toHaveBeenCalledWith(tenantDocuments);
    expect(dbDeleteWhere).toHaveBeenCalled();
    expect(revalidatePath).toHaveBeenCalledWith("/tenants/tenant-1");
  });

  // No storage cleanup is possible for an abandoned upload (nothing was ever
  // received) and no vectors exist yet to reindex — asserting these were
  // never called guards against a future edit accidentally wiring them in.
  it("never calls the docs-signer or triggers a reindex", async () => {
    await abandonUpload("doc-1");

    expect(deleteViaSigner).not.toHaveBeenCalled();
    expect(triggerReindex).not.toHaveBeenCalled();
  });
});

describe("deleteDocument", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authMock.mockResolvedValue({ user: { id: "user-1" } });
    dbSelectWhere.mockResolvedValueOnce([docRow]).mockResolvedValueOnce([tenantRow]);
    deleteViaSigner.mockResolvedValue(undefined);
    dbDeleteWhere.mockResolvedValue(undefined);
    triggerReindex.mockResolvedValue({ ok: true });
  });

  it("deletes via the signer using the tenant the document belongs to, then removes the row", async () => {
    const result = await deleteDocument("doc-1");

    expect(deleteViaSigner).toHaveBeenCalledWith(tenantRow, "docs/uuid-file.pdf");
    expect(dbDeleteWhere).toHaveBeenCalled();
    expect(triggerReindex).toHaveBeenCalledWith(tenantRow);
    expect(revalidatePath).toHaveBeenCalledWith("/tenants/tenant-1");
    expect(result).toEqual({ ok: true });
  });

  it("does not delete the row when the signer call fails", async () => {
    deleteViaSigner.mockRejectedValue(new Error("docs-signer returned 400"));

    await expect(deleteDocument("doc-1")).rejects.toThrow("docs-signer returned 400");
    expect(dbDeleteWhere).not.toHaveBeenCalled();
  });

  it("returns a warning (not a thrown error) when deletion succeeded but reindexing failed", async () => {
    triggerReindex.mockResolvedValue({ ok: false, error: "backend unreachable" });

    const result = await deleteDocument("doc-1");

    expect(result).toEqual({
      ok: false,
      warning: "Deleted, but reindexing failed: backend unreachable",
    });
    expect(dbDeleteWhere).toHaveBeenCalled();
  });

  it("throws 'Tenant not found' when the caller does not own the document's tenant", async () => {
    dbSelectWhere.mockReset();
    dbSelectWhere.mockResolvedValueOnce([docRow]).mockResolvedValueOnce([]);

    await expect(deleteDocument("doc-1")).rejects.toThrow("Tenant not found");
    expect(deleteViaSigner).not.toHaveBeenCalled();
  });
});
