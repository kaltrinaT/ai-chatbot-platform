"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

type ProgressResponse = {
  deployment: {
    id: string;
    status: "pending" | "running" | "succeeded" | "failed" | "cancelled";
    githubRunId: string | null;
    githubRunUrl: string | null;
    startedAt: string;
    finishedAt: string | null;
    errorMessage: string | null;
  };
  live: {
    runStatus: string;
    runConclusion: string | null;
    runStartedAt: string | null;
    currentJobName: string | null;
    currentStepName: string | null;
    stepsCompleted: number;
    stepsTotal: number;
  } | null;
  githubError: "run_not_found" | "github_auth" | "github_unavailable" | null;
  reconciled: boolean;
};

const POLL_MS = 5_000;
const WAITING_HINT_MS = 3 * 60_000;

function formatElapsed(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export default function DeploymentProgress({
  deploymentId,
  startedAt,
  initialRunUrl,
}: {
  deploymentId: string;
  startedAt: string;
  initialRunUrl: string | null;
}) {
  const router = useRouter();
  const [data, setData] = useState<ProgressResponse | null>(null);
  const [failures, setFailures] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const inFlight = useRef(false);
  const done = useRef(false);

  useEffect(() => {
    async function poll() {
      if (done.current || inFlight.current) return;
      if (document.visibilityState === "hidden") return;
      inFlight.current = true;
      try {
        const res = await fetch(`/api/deployments/${deploymentId}/progress`, {
          cache: "no-store",
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body: ProgressResponse = await res.json();
        setData(body);
        setFailures(0);
        if (body.deployment.status !== "pending" && body.deployment.status !== "running") {
          done.current = true;
          router.refresh();
        }
      } catch {
        setFailures((f) => f + 1);
      } finally {
        inFlight.current = false;
      }
    }

    poll();
    const interval = setInterval(poll, POLL_MS);
    return () => clearInterval(interval);
  }, [deploymentId, router]);

  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, []);

  const elapsedMs = now - new Date(startedAt).getTime();
  const live = data?.live ?? null;
  const status = data?.deployment.status;
  const runUrl = data?.deployment.githubRunUrl ?? initialRunUrl;
  const isTerminal = status && status !== "pending" && status !== "running";

  if (isTerminal) {
    return (
      <div className="mt-3 rounded border border-gray-200 bg-gray-50 p-3 text-xs text-gray-600">
        Deployment finished ({status}). Refreshing…
      </div>
    );
  }

  return (
    <div className="mt-3 rounded border border-blue-200 bg-blue-50 p-3 text-xs">
      <div className="flex items-center gap-2">
        <span
          aria-hidden
          className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-blue-500 border-t-transparent"
        />
        <span className="font-medium text-blue-900">
          {live
            ? live.runStatus === "in_progress"
              ? "Deployment in progress"
              : "Run queued on GitHub"
            : data?.githubError
              ? "Deployment running — live status unavailable"
              : "Waiting for workflow run to start…"}
        </span>
        <span className="ml-auto font-mono text-blue-700">{formatElapsed(elapsedMs)}</span>
      </div>

      {live && (live.currentJobName || live.currentStepName) && (
        <div className="mt-2 text-blue-800">
          {live.currentJobName}
          {live.currentStepName && (
            <>
              {" · "}
              <span className="font-medium">{live.currentStepName}</span>
            </>
          )}
          {live.stepsTotal > 0 && (
            <span className="ml-1 text-blue-600">
              (step {Math.min(live.stepsCompleted + 1, live.stepsTotal)}/{live.stepsTotal})
            </span>
          )}
        </div>
      )}

      {!live && !data?.githubError && elapsedMs > WAITING_HINT_MS && (
        <div className="mt-2 rounded bg-amber-100 px-2 py-1 text-amber-800">
          Still waiting for GitHub to start the run — check the Actions tab if this persists.
        </div>
      )}

      {data?.githubError && (
        <div className="mt-2 text-blue-700">
          {data.githubError === "github_auth"
            ? "The platform's GitHub token can't read run status; the final webhook will still update this page."
            : data.githubError === "run_not_found"
              ? "The GitHub run could not be found."
              : "GitHub is unreachable right now; retrying."}
        </div>
      )}

      {failures >= 3 && <div className="mt-2 text-blue-700">Reconnecting…</div>}

      <div className="mt-2 flex items-center gap-3">
        {runUrl && (
          <a
            href={runUrl}
            target="_blank"
            rel="noreferrer"
            className="text-blue-600 hover:underline"
          >
            View GitHub Actions run &rarr;
          </a>
        )}
      </div>
    </div>
  );
}
