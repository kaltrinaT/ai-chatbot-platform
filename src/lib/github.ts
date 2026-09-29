import { Octokit } from "@octokit/rest";
import AdmZip from "adm-zip";
import { z } from "zod";

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

/** getChatbotRepo, or null for a page that should still render without it. */
export function findChatbotRepo(): { owner: string; repo: string } | null {
  try {
    return getChatbotRepo();
  } catch {
    return null;
  }
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

export type RunStep = {
  name: string;
  status: "queued" | "in_progress" | "completed";
  conclusion: string | null;
  startedAt: string | null;
  completedAt: string | null;
};

/**
 * Every step of every job for a run, in order — works for a still-running
 * run (steps not yet started have null timestamps) just as well as a
 * completed one, since GitHub retains step timing on finished runs too.
 * Used for the deployment detail view's step-by-step timeline.
 */
export async function fetchRunSteps(runId: number): Promise<RunStep[]> {
  const { owner, repo } = getChatbotRepo();
  const client = getOctokit();

  const { data } = await client.actions.listJobsForWorkflowRun({
    owner,
    repo,
    run_id: runId,
    filter: "latest",
    per_page: 30,
  });

  return data.jobs.flatMap((job) =>
    (job.steps ?? []).map((step) => ({
      name: step.name,
      status: step.status,
      conclusion: step.conclusion,
      startedAt: step.started_at ?? null,
      completedAt: step.completed_at ?? null,
    })),
  );
}

/**
 * The error lines a run's failed jobs reported — what GitHub shows at the top
 * of the run, and what an operator would otherwise have to open the run to
 * read. For a sign-in that failed, one of them carries the cloud's own error.
 */
export async function fetchFailureAnnotations(runId: number): Promise<string[]> {
  const { owner, repo } = getChatbotRepo();
  const client = getOctokit();

  const { data } = await client.actions.listJobsForWorkflowRun({
    owner,
    repo,
    run_id: runId,
    filter: "latest",
    per_page: 30,
  });

  const messages: string[] = [];
  for (const job of data.jobs.filter((j) => j.conclusion === "failure")) {
    const { data: annotations } = await client.checks.listAnnotations({
      owner,
      repo,
      check_run_id: job.id,
      per_page: 50,
    });
    for (const a of annotations) {
      if (a.annotation_level === "failure" && a.message) messages.push(a.message);
    }
  }
  return messages;
}

/**
 * Locate a dispatched run by a platform-generated ID embedded in its
 * `run-name:`, which GitHub exposes as `display_title`.
 *
 * workflow_dispatch returns nothing identifying the run it started, so this is
 * the only way to tie a dispatch to its run without a callback from inside the
 * workflow. Deploys use it as a fallback when the early "run started" callback
 * was lost; connection checks use it as the only route, since they have no row
 * to call back to.
 *
 * `workflowId` must match whichever workflow file was actually dispatched —
 * searching the wrong one silently never matches.
 */
export async function findRunByMarker(
  marker: string,
  startedAt: Date,
  workflowId: string,
): Promise<{ runId: number; htmlUrl: string } | null> {
  const { owner, repo } = getChatbotRepo();
  const client = getOctokit();

  // 5-minute buffer guards against clock skew between platform and GitHub.
  const createdAfter = new Date(startedAt.getTime() - 5 * 60_000).toISOString();

  const { data } = await client.actions.listWorkflowRuns({
    owner,
    repo,
    workflow_id: workflowId,
    event: "workflow_dispatch",
    created: `>=${createdAfter}`,
    per_page: 30,
  });

  const match = data.workflow_runs.find((r) => r.display_title.includes(marker));
  return match ? { runId: match.id, htmlUrl: match.html_url } : null;
}

/**
 * The deployment-shaped call of findRunByMarker: a deploy or teardown embeds
 * its deployment row's ID in the run name.
 */
export async function findRunForDeployment(
  deploymentId: string,
  startedAt: Date,
  workflowId: string,
): Promise<{ runId: number; htmlUrl: string } | null> {
  return findRunByMarker(deploymentId, startedAt, workflowId);
}

const DeploymentOutputs = z.object({
  chatbotUrl: z.string().optional(),
  albDnsName: z.string().optional(),
  docsSignerUrl: z.string().optional(),
});
export type DeploymentOutputs = z.infer<typeof DeploymentOutputs>;

/**
 * Recovers Terraform outputs (chatbot URL etc.) from the "Upload deployment
 * outputs" artifact a deploy workflow uploads right after `terraform apply`.
 * This is the fallback for when the workflow's direct webhook POST to the
 * platform was lost — the artifact lives entirely in the platform's own CI,
 * so reading it doesn't cross into the customer's AWS account.
 */
export async function fetchDeploymentOutputsArtifact(
  runId: number,
): Promise<DeploymentOutputs | null> {
  const { owner, repo } = getChatbotRepo();
  const client = getOctokit();

  const { data } = await client.actions.listWorkflowRunArtifacts({ owner, repo, run_id: runId });
  const artifact = data.artifacts.find(
    (a) => a.name.startsWith("deployment-outputs") && !a.expired,
  );
  if (!artifact) return null;

  const download = await client.actions.downloadArtifact({
    owner,
    repo,
    artifact_id: artifact.id,
    archive_format: "zip",
  });
  const zip = new AdmZip(Buffer.from(download.data as ArrayBuffer));
  const entry = zip.getEntry("outputs.json");
  if (!entry) return null;

  return DeploymentOutputs.parse(JSON.parse(entry.getData().toString("utf8")));
}
