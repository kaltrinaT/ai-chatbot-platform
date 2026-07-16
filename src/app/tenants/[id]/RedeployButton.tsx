"use client";

import { useFormStatus } from "react-dom";
import { redeployTenant } from "./actions";

export default function RedeployButton({
  tenantId,
  disabled,
}: {
  tenantId: string;
  disabled?: boolean;
}) {
  return (
    <form
      action={redeployTenant}
      onSubmit={(e) => {
        if (!confirm("Trigger a new deployment for this tenant? This re-runs Terraform in place.")) {
          e.preventDefault();
        }
      }}
    >
      <input type="hidden" name="tenantId" value={tenantId} />
      <SubmitButton disabled={disabled} />
    </form>
  );
}

function SubmitButton({ disabled }: { disabled?: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={disabled || pending}
      title={disabled ? "A deployment is already in progress" : undefined}
      className="rounded-md border px-4 py-2 text-sm font-medium hover:bg-gray-50 disabled:opacity-50"
    >
      {pending ? "Redeploying…" : "Redeploy"}
    </button>
  );
}
