"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Upload } from "lucide-react";
import { requestUploadUrl, confirmUpload, abandonUpload } from "./actions";

type UploadStatus = "preparing" | "uploading" | "reindexing" | "done" | "error";
type UploadState = { name: string; status: UploadStatus; error?: string };

const STATUS_LABEL: Record<UploadStatus, string> = {
  preparing: "requesting an upload link…",
  uploading: "sending to your cloud storage…",
  reindexing: "reindexing…",
  done: "done",
  error: "failed",
};

export default function UploadDocumentForm({ tenantId }: { tenantId: string }) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploads, setUploads] = useState<UploadState[]>([]);

  async function uploadOne(file: File) {
    const label = file.name;
    const setStatus = (status: UploadStatus, error?: string) =>
      setUploads((u) => u.map((x) => (x.name === label ? { ...x, status, error } : x)));

    setUploads((u) => [...u, { name: label, status: "preparing" }]);

    let documentId: string | undefined;
    try {
      let requested: Awaited<ReturnType<typeof requestUploadUrl>>;
      try {
        requested = await requestUploadUrl(
          tenantId,
          file.name,
          file.type || "application/octet-stream",
          file.size,
        );
      } catch (err) {
        throw new Error(
          `Couldn't get an upload link from the platform. ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      documentId = requested.documentId;
      const { url, fields } = requested;

      setStatus("uploading");

      let res: Response;
      try {
        if (fields) {
          // AWS — S3 presigned POST: policy fields first, file bytes last.
          const formData = new FormData();
          for (const [key, value] of Object.entries(fields)) formData.append(key, value);
          formData.append("file", file);
          res = await fetch(url, { method: "POST", body: formData });
        } else {
          // Azure — Blob SAS: raw PUT of the file bytes, blob type header required.
          res = await fetch(url, {
            method: "PUT",
            headers: {
              "x-ms-blob-type": "BlockBlob",
              "Content-Type": file.type || "application/octet-stream",
            },
            body: file,
          });
        }
      } catch {
        // fetch only rejects on network-level failures; a blocked CORS
        // preflight looks exactly like this and reports nothing readable.
        throw new Error(
          "Couldn't reach your cloud storage. This is usually the storage account's CORS rule not allowing the address you're browsing from.",
        );
      }

      if (!res.ok) {
        throw new Error(
          res.status === 403
            ? `Your cloud storage rejected the upload (403). The upload link's permissions don't match what the storage account allows.`
            : `Your cloud storage rejected the upload (${res.status} ${res.statusText}).`,
        );
      }

      setStatus("reindexing");

      const confirmed = await confirmUpload(requested.documentId);
      setStatus(confirmed.ok ? "done" : "error", confirmed.warning);
    } catch (err) {
      // Drop the pending row this upload created, so a document the tenant's
      // storage never received doesn't sit in the list forever. Best-effort:
      // the upload error is what the user needs to see, not a cleanup failure.
      if (documentId) await abandonUpload(documentId).catch(() => undefined);

      setStatus("error", err instanceof Error ? err.message : String(err));
    } finally {
      router.refresh();
    }
  }

  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    await Promise.all(Array.from(files).map(uploadOne));
    if (inputRef.current) inputRef.current.value = "";
  }

  return (
    <div>
      <div className="flex items-center gap-3">
        <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700">
          <Upload className="h-4 w-4" />
          Upload Documents
          <input
            ref={inputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => handleFiles(e.target.files)}
          />
        </label>
        {uploads.length > 0 && (
          <button
            type="button"
            onClick={() => setUploads([])}
            className="text-xs text-gray-500 hover:text-gray-700"
          >
            Clear
          </button>
        )}
      </div>

      {uploads.length > 0 && (
        <ul className="mt-3 space-y-2">
          {uploads.map((u, i) => (
            <li
              key={`${u.name}-${i}`}
              className={`rounded-md border px-3 py-2 text-sm ${
                u.status === "error"
                  ? "border-red-200 bg-red-50"
                  : u.status === "done"
                    ? "border-green-200 bg-green-50"
                    : "border-gray-200 bg-gray-50"
              }`}
            >
              <div className="flex items-center justify-between gap-3">
                <span className="truncate font-medium text-gray-900">{u.name}</span>
                <span
                  className={
                    u.status === "error"
                      ? "shrink-0 text-red-700"
                      : u.status === "done"
                        ? "shrink-0 text-green-700"
                        : "shrink-0 text-gray-600"
                  }
                >
                  {STATUS_LABEL[u.status]}
                </span>
              </div>
              {u.error && <p className="mt-1 text-xs text-red-700">{u.error}</p>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
