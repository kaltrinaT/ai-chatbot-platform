"use client";

import { MoreHorizontal } from "lucide-react";
import DeleteDocumentButton from "./DeleteDocumentButton";

export default function DocumentActionsMenu({ documentId }: { documentId: string }) {
  return (
    <details className="relative">
      <summary
        className="flex h-7 w-7 cursor-pointer list-none items-center justify-center rounded-md text-gray-500 hover:bg-gray-100 [&::-webkit-details-marker]:hidden"
        aria-label="Document actions"
      >
        <MoreHorizontal className="h-4 w-4" />
      </summary>
      <div className="absolute right-0 z-10 mt-1 w-40 rounded-md border bg-white p-2 shadow-lg">
        <DeleteDocumentButton documentId={documentId} />
      </div>
    </details>
  );
}
