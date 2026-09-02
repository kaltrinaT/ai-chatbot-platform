import { FileText, CheckCircle2, RefreshCw, XCircle } from "lucide-react";
import { PILL_TONE_STYLES } from "@/app/Badge";
import DocumentActionsMenu from "./DocumentActionsMenu";
import { documentStatusLabel, documentTypeLabel, formatBytes, type DocumentRow } from "./utils";

const TYPE_TONES: Record<string, string> = {
  PDF: "bg-red-100 text-red-600",
  DOC: "bg-blue-100 text-blue-600",
  DOCX: "bg-blue-100 text-blue-600",
  XLS: "bg-green-100 text-green-600",
  XLSX: "bg-green-100 text-green-600",
  TXT: "bg-gray-100 text-gray-600",
  MD: "bg-gray-100 text-gray-600",
  CSV: "bg-green-100 text-green-600",
};

const STATUS_ICONS: Record<string, typeof CheckCircle2> = {
  green: CheckCircle2,
  red: XCircle,
  gray: RefreshCw,
};

function StatusPill({ label, tone }: { label: string; tone: "green" | "red" | "gray" }) {
  const Icon = STATUS_ICONS[tone];
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs ${PILL_TONE_STYLES[tone]}`}>
      <Icon className="h-3 w-3" />
      {label}
    </span>
  );
}

export default function DocumentsTable({ documents }: { documents: DocumentRow[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b text-xs text-gray-500">
            <th className="px-4 py-2 font-medium">Document Name</th>
            <th className="px-4 py-2 font-medium">Type</th>
            <th className="px-4 py-2 font-medium">Status</th>
            <th className="px-4 py-2 font-medium">Uploaded</th>
            <th className="px-4 py-2 font-medium">Size</th>
            <th className="px-4 py-2" />
          </tr>
        </thead>
        <tbody className="divide-y">
          {documents.map((doc) => {
            const type = documentTypeLabel(doc.contentType);
            const status = documentStatusLabel(doc.status);
            return (
              <tr key={doc.id}>
                <td className="px-4 py-3">
                  <div className="flex items-center gap-3">
                    <div
                      className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-md ${TYPE_TONES[type] ?? "bg-gray-100 text-gray-600"}`}
                    >
                      <FileText className="h-4 w-4" />
                    </div>
                    <span className="font-medium">{doc.displayName}</span>
                  </div>
                </td>
                <td className="px-4 py-3 text-xs text-gray-600">{type}</td>
                <td className="px-4 py-3">
                  <StatusPill label={status.label} tone={status.tone} />
                </td>
                <td className="px-4 py-3 text-xs text-gray-500">{doc.createdAt.toLocaleString()}</td>
                <td className="px-4 py-3 text-xs text-gray-600">{formatBytes(doc.sizeBytes)}</td>
                <td className="px-4 py-3 text-right">
                  <DocumentActionsMenu documentId={doc.id} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
