import { tenantDocuments } from "@/db/schema";
import UploadDocumentForm from "./UploadDocumentForm";
import DeleteDocumentButton from "./DeleteDocumentButton";

function formatBytes(n: number | null): string {
  if (n == null) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export default function DocumentsSection({
  tenantId,
  docsSignerUrl,
  documents,
}: {
  tenantId: string;
  docsSignerUrl: string | null;
  documents: (typeof tenantDocuments.$inferSelect)[];
}) {
  return (
    <div className="mt-8">
      <h2 className="mb-3 text-lg font-medium">Documents</h2>

      {!docsSignerUrl ? (
        <div className="rounded border border-dashed p-4 text-sm text-gray-500">
          Document upload will be available here once the first deployment succeeds.
        </div>
      ) : (
        <>
          <p className="text-xs text-gray-500">
            Uploads go straight from your browser to your S3 bucket — the platform never
            receives or stores the file contents. Deleting a document removes it from S3, but
            does not remove any answers already derived from it until the chatbot&apos;s
            knowledge base fully re-embeds.
          </p>

          <UploadDocumentForm tenantId={tenantId} />

          {documents.length === 0 ? (
            <p className="mt-4 text-sm text-gray-500">No documents uploaded yet.</p>
          ) : (
            <ul className="mt-4 divide-y rounded border">
              {documents.map((doc) => (
                <li key={doc.id} className="flex items-center justify-between gap-4 p-3 text-sm">
                  <div className="min-w-0">
                    <div className="truncate font-medium">{doc.displayName}</div>
                    <div className="text-xs text-gray-500">
                      {formatBytes(doc.sizeBytes)} · {doc.status} ·{" "}
                      {doc.createdAt.toISOString()}
                    </div>
                  </div>
                  <DeleteDocumentButton documentId={doc.id} />
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
