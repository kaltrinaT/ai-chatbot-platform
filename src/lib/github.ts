import { Octokit } from "@octokit/rest";

let octokit: Octokit | null = null;

export function getOctokit(): Octokit {
  if (!octokit) {
    octokit = new Octokit({ auth: process.env.GITHUB_PAT! });
  }
  return octokit;
}

export function getChatbotRepo(): { owner: string; repo: string } {
  const owner = process.env.CHATBOT_REPO_OWNER;
  const repo = process.env.CHATBOT_REPO_NAME;
  if (!owner || !repo) {
    throw new Error("CHATBOT_REPO_OWNER / CHATBOT_REPO_NAME are not set.");
  }
  return { owner, repo };
}

export function getDeployWorkflowId(): string {
  return process.env.CHATBOT_DEPLOY_WORKFLOW ?? "deploy-tenant.yml";
}

export function getDestroyWorkflowId(): string {
  return process.env.CHATBOT_DESTROY_WORKFLOW ?? "destroy-tenant.yml";
}

export type RunProgress = {
  runStatus: string;
  runConclusion: string | null;
  runStartedAt: string | null;
  htmlUrl: string;
  updatedAt: string;
  currentJobName: string | null;
  currentStepName: string | null;
  stepsCompleted: number;
  stepsTotal: number;
};

export async function fetchRunProgress(runId: number): Promise<RunProgress> {
  const { owner, repo } = getChatbotRepo();
  const client = getOctokit();

  const [runRes, jobsRes] = await Promise.all([
    client.actions.getWorkflowRun({ owner, repo, run_id: runId }),
    client.actions.listJobsForWorkflowRun({
      owner,
      repo,
      run_id: runId,
      filter: "latest",
      per_page: 30,
    }),
  ]);

  const run = runRes.data;
  const jobs = jobsRes.data.jobs;

  const currentJob =
    jobs.find((j) => j.status === "in_progress") ??
    jobs.find((j) => j.status === "queued") ??
    jobs[0] ??
    null;

  const steps = currentJob?.steps ?? [];
  const currentStep =
    steps.find((s) => s.status === "in_progress") ??
    steps.find((s) => s.status !== "completed") ??
    null;

  return {
    runStatus: run.status ?? "queued",
    runConclusion: run.conclusion ?? null,
    runStartedAt: run.run_started_at ?? null,
    htmlUrl: run.html_url,
    updatedAt: run.updated_at,
    currentJobName: currentJob?.name ?? null,
    currentStepName: currentStep?.name ?? null,
    stepsCompleted: steps.filter((s) => s.status === "completed").length,
    stepsTotal: steps.length,
  };
}

/**
 * Locate the workflow run for a deployment when the early "run started"
 * callback never arrived. Relies on the workflow's `run-name:` embedding the
 * deployment ID, which GitHub exposes as `display_title`.
 */
export async function findRunForDeployment(
  deploymentId: string,
  startedAt: Date,
): Promise<{ runId: number; htmlUrl: string } | null> {
  const { owner, repo } = getChatbotRepo();
  const client = getOctokit();

  // 5-minute buffer guards against clock skew between platform and GitHub.
  const createdAfter = new Date(startedAt.getTime() - 5 * 60_000).toISOString();

  const { data } = await client.actions.listWorkflowRuns({
    owner,
    repo,
    workflow_id: getDeployWorkflowId(),
    event: "workflow_dispatch",
    created: `>=${createdAfter}`,
    per_page: 30,
  });

  const match = data.workflow_runs.find((r) =>
    r.display_title.includes(deploymentId),
  );
  return match ? { runId: match.id, htmlUrl: match.html_url } : null;
}
