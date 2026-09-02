"use client";

import { useState } from "react";
import { useFormStatus } from "react-dom";
import { deleteTenant } from "./actions";

export default function DeleteTenantButton({
  tenantId,
  slug,
  disabled,
  disabledReason,
}: {
  tenantId: string;
  slug: string;
  disabled?: boolean;
  disabledReason?: string;
}) {
  const [confirmText, setConfirmText] = useState("");
  const [open, setOpen] = useState(false);
  const matches = confirmText === slug;

  if (!open) {
    return (
      <button
        type="button"
        disabled={disabled}
        title={disabled ? disabledReason : undefined}
        onClick={() => setOpen(true)}
        className="rounded-md border border-red-200 px-4 py-2 text-sm font-medium text-red-700 hover:bg-red-50 disabled:opacity-50"
      >
        Delete tenant
      </button>
    );
  }

  return (
    <form
      action={deleteTenant}
      className="w-80 rounded-md border border-red-200 bg-red-50 p-3 text-sm"
      onSubmit={(e) => {
        if (!matches) e.preventDefault();
      }}
    >
      <input type="hidden" name="tenantId" value={tenantId} />
      <p className="text-red-800">
        This permanently tears down the tenant&apos;s AWS infrastructure and cannot be
        undone. Type <span className="font-mono font-semibold">{slug}</span> to confirm.
      </p>
      <input
        value={confirmText}
        onChange={(e) => setConfirmText(e.target.value)}
        placeholder={slug}
        className="mt-2 w-full rounded border border-red-300 px-2 py-1 font-mono text-xs"
        autoFocus
      />
      <div className="mt-2 flex gap-2">
        <SubmitButton disabled={!matches} />
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            setConfirmText("");
          }}
          className="rounded-md border px-3 py-1.5 text-xs font-medium hover:bg-white"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

function SubmitButton({ disabled }: { disabled?: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={disabled || pending}
      className="rounded-md bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-50"
    >
      {pending ? "Deleting…" : "Confirm delete"}
    </button>
  );
}
