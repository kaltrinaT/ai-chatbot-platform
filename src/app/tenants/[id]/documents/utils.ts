import type { tenantDocuments } from "@/db/schema";

export type DocumentRow = typeof tenantDocuments.$inferSelect;
export type DocumentStatusTone = "green" | "red" | "gray";

export function formatBytes(n: number | null): string {
  if (n == null) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

const TYPE_LABELS: Record<string, string> = {
  "application/pdf": "PDF",
  "application/msword": "DOC",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "DOCX",
  "application/vnd.ms-excel": "XLS",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "XLSX",
  "text/plain": "TXT",
  "text/markdown": "MD",
  "text/csv": "CSV",
  "text/html": "HTML",
  "application/json": "JSON",
};

// Falls back to the MIME subtype (e.g. "application/x-foo" -> "X-FOO") for
// anything not in the map above, rather than hiding the type entirely.
export function documentTypeLabel(contentType: string): string {
  return TYPE_LABELS[contentType] ?? contentType.split("/").pop()?.toUpperCase() ?? "FILE";
}

// Real upload-pipeline status only (pending/uploaded/failed) — there is no
// tracked "indexed into the vector store" state distinct from this.
export function documentStatusLabel(status: DocumentRow["status"]): { label: string; tone: DocumentStatusTone } {
  if (status === "uploaded") return { label: "Uploaded", tone: "green" };
  if (status === "failed") return { label: "Failed", tone: "red" };
  return { label: "Pending", tone: "gray" };
}

export type DocumentStats = {
  total: number;
  uploaded: number;
  pending: number;
  failed: number;
  storageBytes: number;
};

export function computeDocumentStats(documents: DocumentRow[]): DocumentStats {
  return {
    total: documents.length,
    uploaded: documents.filter((d) => d.status === "uploaded").length,
    pending: documents.filter((d) => d.status === "pending").length,
    failed: documents.filter((d) => d.status === "failed").length,
    storageBytes: documents.reduce((sum, d) => sum + (d.sizeBytes ?? 0), 0),
  };
}

export type DocumentFilters = {
  q?: string;
  status?: "uploaded" | "pending" | "failed";
  type?: string;
};

export function filterDocuments(documents: DocumentRow[], filters: DocumentFilters): DocumentRow[] {
  return documents.filter((d) => {
    if (filters.q && !d.displayName.toLowerCase().includes(filters.q.toLowerCase())) return false;
    if (filters.status && d.status !== filters.status) return false;
    if (filters.type && documentTypeLabel(d.contentType) !== filters.type) return false;
    return true;
  });
}
