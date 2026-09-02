import Link from "next/link";
import { CheckCircle2, Circle, RefreshCw, X } from "lucide-react";
import { fetchRunSteps, type RunStep } from "@/lib/github";
import { PILL_TONE_STYLES } from "@/app/Badge";
import { deploymentStatusMeta, formatDuration, type DeploymentRow } from "./utils";

export default async function DeploymentDetailsPanel({
  deployment,
  deployedByName,
  region,
  ordinal,
  closeHref,
}: {
  deployment: DeploymentRow;
  deployedByName: string | null;
  region: string;
  ordinal: number;
  closeHref: string;
}) {
  const status = deploymentStatusMeta(deployment.status);

  // Best-effort: the run may be too old for GitHub to have retained job
  // data, or the dispatch may never have resolved to a run at all.
  let steps: RunStep[] = [];
  if (deployment.githubRunId) {
    try {
      steps = await fetchRunSteps(Number(deployment.githubRunId));
    } catch {
      steps = [];
    }
  }

  return (
    <div className="w-80 shrink-0 rounded-lg border bg-white p-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold">Deployment Details</h2>
        <Link href={closeHref} aria-label="Close" className="text-gray-400 hover:text-gray-600">
          <X className="h-4 w-4" />
        </Link>
      </div>

      <div className="mb-4">
        <div className="text-base font-semibold">Deployment #{ordinal}</div>
        <span
          className={`mt-1 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs ${PILL_TONE_STYLES[status.tone]}`}
        >
          {status.label}
        </span>
      </div>

      <dl className="space-y-2 text-sm">
        <DetailRow label="Started">{deployment.startedAt.toLocaleString()}</DetailRow>
        <DetailRow label="Completed">{deployment.finishedAt ? deployment.finishedAt.toLocaleString() : "—"}</DetailRow>
        <DetailRow label="Duration">{formatDuration(deployment.startedAt, deployment.finishedAt)}</DetailRow>
        <DetailRow label="Environment">{`Production (${region})`}</DetailRow>
        <DetailRow label="Version">v{deployment.chatbotVersion}</DetailRow>
        <DetailRow label="GitHub Run">
          {deployment.githubRunUrl ? (
            <a href={deployment.githubRunUrl} target="_blank" rel="noreferrer" className="text-blue-600 hover:underline">
              View workflow run ↗
            </a>
          ) : (
            "—"
          )}
        </DetailRow>
        <DetailRow label="Deployed By">{deployedByName ?? "Unknown"}</DetailRow>
      </dl>

      {deployment.errorMessage && (
        <div className="mt-3 rounded bg-red-50 p-2 text-xs text-red-700">{deployment.errorMessage}</div>
      )}

      <div className="mt-5">
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-400">Deployment Steps</h3>
        {steps.length === 0 ? (
          <p className="text-xs text-gray-500">
            {deployment.githubRunId
              ? "Step details aren't available for this run anymore."
              : "No GitHub Actions run is linked to this deployment."}
          </p>
        ) : (
          <ul className="space-y-2">
            {steps.map((step, i) => {
              const Icon =
                step.status === "completed"
                  ? step.conclusion === "success"
                    ? CheckCircle2
                    : X
                  : step.status === "in_progress"
                    ? RefreshCw
                    : Circle;
              const tone =
                step.status === "completed"
                  ? step.conclusion === "success"
                    ? "text-green-600"
                    : "text-red-600"
                  : step.status === "in_progress"
                    ? "text-blue-600"
                    : "text-gray-300";
              const started = step.startedAt ? new Date(step.startedAt) : null;
              const completed = step.completedAt ? new Date(step.completedAt) : null;
              return (
                <li key={`${step.name}-${i}`} className="flex items-center justify-between gap-2 text-xs">
                  <span className="flex items-center gap-2 text-gray-700">
                    <Icon className={`h-3.5 w-3.5 shrink-0 ${tone} ${step.status === "in_progress" ? "animate-spin" : ""}`} />
                    {step.name}
                  </span>
                  <span className="shrink-0 text-gray-400">{started ? formatDuration(started, completed) : "—"}</span>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {deployment.githubRunUrl && (
        <a
          href={deployment.githubRunUrl}
          target="_blank"
          rel="noreferrer"
          className="mt-4 block rounded-md border px-3 py-2 text-center text-sm font-medium text-gray-700 hover:bg-gray-50"
        >
          View Logs
        </a>
      )}
    </div>
  );
}

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <dt className="text-gray-500">{label}</dt>
      <dd className="truncate text-right">{children}</dd>
    </div>
  );
}
