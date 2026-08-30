"use client";

import { useFormStatus } from "react-dom";
import { deleteDocument } from "./actions";

export default function DeleteDocumentButton({ documentId }: { documentId: string }) {
  async function action() {
    const result = await deleteDocument(documentId);
    if (!result.ok) alert(result.warning);
  }

  return (
    <form
      action={action}
      onSubmit={(e) => {
        if (!confirm("Delete this document? This removes it from S3 immediately.")) {
          e.preventDefault();
        }
      }}
    >
      <SubmitButton />
    </form>
  );
}

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="text-xs text-red-600 hover:underline disabled:opacity-50"
    >
      {pending ? "Deleting…" : "Delete"}
    </button>
  );
}
