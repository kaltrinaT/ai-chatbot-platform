"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Upload } from "lucide-react";
import { requestUploadUrl, confirmUpload } from "./actions";

type UploadState = { name: string; status: "uploading" | "reindexing" | "done" | "error"; error?: string };

export default function UploadDocumentForm({ tenantId }: { tenantId: string }) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploads, setUploads] = useState<UploadState[]>([]);

  async function uploadOne(file: File) {
    const label = file.name;
    setUploads((u) => [...u, { name: label, status: "uploading" }]);

    try {
      const { documentId, url, fields } = await requestUploadUrl(
        tenantId,
        file.name,
        file.type || "application/octet-stream",
        file.size,
      );

      const formData = new FormData();
      for (const [key, value] of Object.entries(fields)) formData.append(key, value);
      formData.append("file", file);

      const res = await fetch(url, { method: "POST", body: formData });
      if (!res.ok) throw new Error(`Upload to S3 failed (${res.status})`);

      setUploads((u) =>
        u.map((x) => (x.name === label ? { ...x, status: "reindexing" } : x)),
      );

      const confirmed = await confirmUpload(documentId);
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
