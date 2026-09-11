import Link from "next/link";
import { ArrowRight, FileEdit, Trash2 } from "lucide-react";
import { deleteTenantDraft } from "@/app/tenants/new/actions";
import { LAST_INPUT_STEP, STEPS } from "@/app/tenants/new/wizard/steps";
import type { DraftRow } from "../_data/queries";

function stepLabel(step: number): string {
  const title = STEPS.find((s) => s.n === step)?.title;
  return title ? `Step ${step} of ${LAST_INPUT_STEP} · ${title}` : `Step ${step}`;
}

/**
 * Saved-but-unfinished onboarding forms. A draft is only resumable through
 * /tenants/new?draft=<id>, and this is the one place that id is ever shown —
 * without it "Save Draft" writes a row the operator can never reach again.
 */
export default function DraftsCard({ drafts }: { drafts: DraftRow[] }) {
  if (drafts.length === 0) return null;

  return (
    <div className="mb-6 rounded-lg border bg-white">
      <div className="flex items-center gap-2 border-b px-4 py-3">
        <FileEdit className="h-4 w-4 text-gray-500" />
        <h2 className="text-sm font-semibold text-gray-900">Unfinished chatbots</h2>
        <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-600">
          {drafts.length}
        </span>
        <p className="ml-auto text-xs text-gray-500">
          API keys are never saved in a draft — you re-enter them to deploy.
        </p>
      </div>

      <ul className="divide-y">
        {drafts.map((draft) => (
          <li key={draft.id} className="flex items-center gap-4 px-4 py-3">
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-gray-900">
                {draft.name?.trim() || "Untitled draft"}
              </p>
              <p className="mt-0.5 text-xs text-gray-500">
                {stepLabel(draft.step)} · saved {draft.updatedAt.toLocaleString()}
              </p>
            </div>

            <Link
              href={`/tenants/new?draft=${draft.id}`}
              className="flex shrink-0 items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50"
            >
              Resume
              <ArrowRight className="h-3.5 w-3.5" />
            </Link>

            <form action={deleteTenantDraft.bind(null, draft.id)} className="shrink-0">
              <button
                type="submit"
                aria-label={`Discard draft ${draft.name?.trim() || "Untitled draft"}`}
                className="flex h-8 w-8 items-center justify-center rounded-md border text-gray-500 hover:bg-red-50 hover:text-red-600"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </form>
          </li>
        ))}
      </ul>
    </div>
  );
}
