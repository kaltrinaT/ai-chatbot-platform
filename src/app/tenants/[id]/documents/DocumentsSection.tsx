import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";
import DocumentsStatsRow from "./DocumentsStatsRow";
import DocumentsFilterBar from "./DocumentsFilterBar";
import DocumentsTable from "./DocumentsTable";
import UploadDocumentForm from "./UploadDocumentForm";
import {
  computeDocumentStats,
  documentTypeLabel,
  filterDocuments,
  type DocumentFilters,
  type DocumentRow,
} from "./utils";

const PAGE_SIZE = 10;

export default function DocumentsSection({
  tenantId,
  docsSignerUrl,
  documents,
  filters,
  page,
}: {
  tenantId: string;
  docsSignerUrl: string | null;
  documents: DocumentRow[];
  filters: DocumentFilters;
  page: number;
}) {
  if (!docsSignerUrl) {
    return (
      <div className="rounded border border-dashed p-4 text-sm text-gray-500">
        Document upload will be available here once the first deployment succeeds.
      </div>
    );
  }

  const stats = computeDocumentStats(documents);
  const typeOptions = [...new Set(documents.map((d) => documentTypeLabel(d.contentType)))].sort();
  const filtered = filterDocuments(documents, filters);
  const total = filtered.length;
  const pageDocs = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const hasNextPage = page * PAGE_SIZE < total;
  const hasPrevPage = page > 1;
  const showingFrom = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const showingTo = Math.min(page * PAGE_SIZE, total);

  function pageHref(p: number): string {
    const params = new URLSearchParams();
    params.set("tab", "documents");
    if (filters.q) params.set("docQuery", filters.q);
    if (filters.status) params.set("docStatus", filters.status);
    if (filters.type) params.set("docType", filters.type);
    if (p > 1) params.set("docPage", String(p));
    return `/tenants/${tenantId}?${params.toString()}`;
  }

  return (
    <div className="space-y-6">
      <p className="text-xs text-gray-500">
        Uploads go straight from your browser to your cloud storage — the platform never receives or stores
        the file contents. Deleting a document removes it from storage, but does not remove any answers already
        derived from it until the chatbot&apos;s knowledge base fully re-embeds.
      </p>

      <DocumentsStatsRow stats={stats} />

      <div className="rounded-lg border bg-white p-4">
        <h3 className="text-sm font-semibold text-gray-900">Add documents</h3>
        <p className="mt-1 mb-3 text-xs text-gray-500">
          PDF, Word, Markdown, CSV, HTML or plain text, up to 25 MB each. Progress and any errors appear
          below the button.
        </p>
        <UploadDocumentForm tenantId={tenantId} />
      </div>

      <div className="rounded-lg border bg-white">
        <DocumentsFilterBar typeOptions={typeOptions} />

        {documents.length === 0 ? (
          <p className="p-6 text-sm text-gray-500">No documents uploaded yet.</p>
        ) : pageDocs.length === 0 ? (
          <p className="p-6 text-sm text-gray-500">No documents match your search/filters.</p>
        ) : (
          <DocumentsTable documents={pageDocs} />
        )}

        {total > 0 && (
          <div className="flex items-center justify-between border-t px-4 py-3 text-sm">
            <span className="text-gray-500">
              Showing {showingFrom} to {showingTo} of {total} document{total === 1 ? "" : "s"}
            </span>
            <div className="flex items-center gap-2">
              <Link
                href={pageHref(page - 1)}
                aria-disabled={!hasPrevPage}
                className={`flex h-8 w-8 items-center justify-center rounded-md border ${
                  hasPrevPage ? "text-gray-600 hover:bg-gray-50" : "pointer-events-none text-gray-300"
                }`}
              >
                <ChevronLeft className="h-4 w-4" />
              </Link>
              <span className="flex h-8 w-8 items-center justify-center rounded-md bg-blue-600 text-xs font-medium text-white">
                {page}
              </span>
              <Link
                href={pageHref(page + 1)}
                aria-disabled={!hasNextPage}
                className={`flex h-8 w-8 items-center justify-center rounded-md border ${
                  hasNextPage ? "text-gray-600 hover:bg-gray-50" : "pointer-events-none text-gray-300"
                }`}
              >
                <ChevronRight className="h-4 w-4" />
              </Link>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
