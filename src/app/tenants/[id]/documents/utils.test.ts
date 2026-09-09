import { describe, it, expect } from "vitest";
import { computeDocumentStats, filterDocuments, type DocumentRow } from "./utils";

function doc(overrides: Partial<DocumentRow>): DocumentRow {
  return {
    id: crypto.randomUUID(),
    objectKey: "key",
    displayName: "doc.pdf",
    contentType: "application/pdf",
    sizeBytes: 100,
    status: "uploaded",
    createdAt: new Date(),
    ...overrides,
  } as DocumentRow;
}

describe("filterDocuments", () => {
  const documents = [
    doc({ displayName: "uploaded-one.pdf", status: "uploaded" }),
    doc({ displayName: "pending-one.md", status: "pending", contentType: "text/markdown" }),
    doc({ displayName: "failed-one.pdf", status: "failed" }),
  ];

  it("returns everything when no filters are set", () => {
    expect(filterDocuments(documents, {})).toHaveLength(3);
  });

  it("keeps only documents matching the requested status", () => {
    const uploaded = filterDocuments(documents, { status: "uploaded" });
    expect(uploaded.map((d) => d.displayName)).toEqual(["uploaded-one.pdf"]);
    expect(uploaded.every((d) => d.status === "uploaded")).toBe(true);
  });

  it("excludes pending documents when filtering for uploaded", () => {
    const uploaded = filterDocuments(documents, { status: "uploaded" });
    expect(uploaded.some((d) => d.status === "pending")).toBe(false);
  });

  it("matches names case-insensitively", () => {
    expect(filterDocuments(documents, { q: "PENDING-ONE" })).toHaveLength(1);
  });

  it("combines status and type filters", () => {
    expect(filterDocuments(documents, { status: "pending", type: "PDF" })).toHaveLength(0);
  });
});

describe("computeDocumentStats", () => {
  it("counts each status and sums stored bytes", () => {
    const stats = computeDocumentStats([
      doc({ status: "uploaded", sizeBytes: 10 }),
      doc({ status: "pending", sizeBytes: 20 }),
      doc({ status: "failed", sizeBytes: 30 }),
    ]);
    expect(stats).toMatchObject({ total: 3, uploaded: 1, pending: 1, failed: 1, storageBytes: 60 });
  });
});
