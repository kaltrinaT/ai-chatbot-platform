"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Upload } from "lucide-react";
import { requestUploadUrl, confirmUpload, abandonUpload } from "./actions";

type UploadState = { name: string; status: "uploading" | "reindexing" | "done" | "error"; error?: string };

export default function UploadDocumentForm({ tenantId }: { tenantId: string }) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploads, setUploads] = useState<UploadState[]>([]);

  async function uploadOne(file: File) {
    const label = file.name;
    setUploads((u) => [...u, { name: label, status: "uploading" }]);

    let documentId: string | undefined;
    try {
      const requested = await requestUploadUrl(
        tenantId,
        file.name,
        file.type || "application/octet-stream",
        file.size,
      );
      const { url, fields } = requested;
      documentId = requested.documentId;

      let res: Response;
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
      if (!res.ok) throw new Error(`Upload failed (${res.status})`);

      setUploads((u) =>
        u.map((x) => (x.name === label ? { ...x, status: "reindexing" } : x)),
      );

      const confirmed = await confirmUpload(requested.documentId);
      setUploads((u) =>
        u.map((x) =>
          x.name === label
            ? confirmed.ok
              ? { ...x, status: "done" }
              : { ...x, status: "error", error: confirmed.warning }
            : x,
        ),
      );
    } catch (err) {
      // Drop the pending row this upload created, so a document the tenant's
      // storage never received doesn't sit in the list forever. Best-effort:
      // the upload error is what the user needs to see, not a cleanup failure.
      if (documentId) await abandonUpload(documentId).catch(() => undefined);

      setUploads((u) =>
        u.map((x) =>
          x.name === label
            ? { ...x, status: "error", error: err instanceof Error ? err.message : String(err) }
            : x,
        ),
      );
    } finally {
      router.refresh();
    }
  }

  async function handleFiles(files: FileList | null) {
    if (!files) return;
    await Promise.all(Array.from(files).map(uploadOne));
    if (inputRef.current) inputRef.current.value = "";
  }

  return (
    <div>
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
        <ul className="mt-2 space-y-1 text-xs">
          {uploads.map((u, i) => (
            <li key={`${u.name}-${i}`} className="flex items-center gap-2">
              <span className="font-mono">{u.name}</span>
              <span
                className={
                  u.status === "error"
                    ? "text-red-600"
                    : u.status === "done"
                      ? "text-green-700"
                      : "text-gray-500"
                }
              >
                {u.status === "uploading" && "uploading…"}
                {u.status === "reindexing" && "reindexing…"}
                {u.status === "done" && "done"}
                {u.status === "error" && (u.error ?? "failed")}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
