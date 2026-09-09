import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Octokit } from "@octokit/rest";
import AdmZip from "adm-zip";

const getWorkflowRun = vi.fn();
const listJobsForWorkflowRun = vi.fn();
const listWorkflowRuns = vi.fn();
const listWorkflowRunArtifacts = vi.fn();
const downloadArtifact = vi.fn();

vi.mock("@octokit/rest", () => ({
  // A regular function (not an arrow function) so `new Octokit(...)` in the
  // source can construct it — an arrow-function implementation isn't a valid
  // constructor and throws "is not a constructor".
  Octokit: vi.fn().mockImplementation(function () {
    return {
      actions: {
        getWorkflowRun,
        listJobsForWorkflowRun,
        listWorkflowRuns,
        listWorkflowRunArtifacts,
        downloadArtifact,
      },
    };
  }),
}));

function zipWithOutputs(outputs: Record<string, unknown>): Buffer {
  const zip = new AdmZip();
  zip.addFile("outputs.json", Buffer.from(JSON.stringify(outputs)));
  return zip.toBuffer();
}

describe("github", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    getWorkflowRun.mockReset();
    listJobsForWorkflowRun.mockReset();
    listWorkflowRuns.mockReset();
    listWorkflowRunArtifacts.mockReset();
    downloadArtifact.mockReset();
    vi.mocked(Octokit).mockClear();
    process.env = { ...originalEnv };
    process.env.CHATBOT_REPO_OWNER = "acme";
    process.env.CHATBOT_REPO_NAME = "chatbot";
    process.env.GITHUB_PAT = "test-pat";
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("getChatbotRepo", () => {
    it("returns owner/repo from env", async () => {
      const { getChatbotRepo } = await import("./github");
      expect(getChatbotRepo()).toEqual({ owner: "acme", repo: "chatbot" });
    });

    it("throws when CHATBOT_REPO_OWNER or CHATBOT_REPO_NAME are missing", async () => {
      delete process.env.CHATBOT_REPO_OWNER;
      const { getChatbotRepo } = await import("./github");
      expect(() => getChatbotRepo()).toThrow(/CHATBOT_REPO_OWNER/);
    });
  });

  describe("getDeployWorkflowId", () => {
    it("defaults to deploy-tenant.yml", async () => {
      delete process.env.CHATBOT_DEPLOY_WORKFLOW;
      const { getDeployWorkflowId } = await import("./github");
      expect(getDeployWorkflowId()).toBe("deploy-tenant.yml");
    });

    it("honors an override", async () => {
      process.env.CHATBOT_DEPLOY_WORKFLOW = "custom.yml";
      const { getDeployWorkflowId } = await import("./github");
      expect(getDeployWorkflowId()).toBe("custom.yml");
    });
  });

  describe("getDestroyWorkflowId", () => {
    it("defaults to destroy-tenant.yml", async () => {
      delete process.env.CHATBOT_DESTROY_WORKFLOW;
      const { getDestroyWorkflowId } = await import("./github");
      expect(getDestroyWorkflowId()).toBe("destroy-tenant.yml");
    });

    it("honors an override", async () => {
      process.env.CHATBOT_DESTROY_WORKFLOW = "custom-destroy.yml";
      const { getDestroyWorkflowId } = await import("./github");
      expect(getDestroyWorkflowId()).toBe("custom-destroy.yml");
    });
  });

  describe("getOctokit", () => {
    it("constructs the client once with GITHUB_PAT and reuses it on later calls", async () => {
      const { getOctokit } = await import("./github");

      const first = getOctokit();
      const second = getOctokit();

      expect(first).toBe(second);
      expect(Octokit).toHaveBeenCalledTimes(1);
      expect(Octokit).toHaveBeenCalledWith({ auth: "test-pat" });
    });

    it("constructs a fresh client per module instance (no leakage across resetModules)", async () => {
      const { getOctokit: getOctokitA } = await import("./github");
      getOctokitA();

      vi.resetModules();
      const { getOctokit: getOctokitB } = await import("./github");
      getOctokitB();

      expect(Octokit).toHaveBeenCalledTimes(2);
    });
  });

  describe("fetchRunProgress", () => {
    it("picks the in-progress job/step and counts completed steps", async () => {
      getWorkflowRun.mockResolvedValue({
        data: {
          status: "in_progress",
          conclusion: null,
          run_started_at: "2026-01-01T00:00:00Z",
          html_url: "https://github.com/acme/chatbot/actions/runs/1",
          updated_at: "2026-01-01T00:05:00Z",
        },
      });
      listJobsForWorkflowRun.mockResolvedValue({
        data: {
          jobs: [
            {
              name: "deploy",
              status: "in_progress",
              steps: [
                { name: "checkout", status: "completed" },
                { name: "terraform apply", status: "in_progress" },
                { name: "notify", status: "queued" },
              ],
            },
          ],
        },
      });

      const { fetchRunProgress } = await import("./github");
      const progress = await fetchRunProgress(1);

      expect(progress.currentJobName).toBe("deploy");
      expect(progress.currentStepName).toBe("terraform apply");
      expect(progress.stepsCompleted).toBe(1);
      expect(progress.stepsTotal).toBe(3);
      expect(progress.runStatus).toBe("in_progress");
    });

    it("falls back to a queued job when nothing is in progress", async () => {
      getWorkflowRun.mockResolvedValue({
        data: {
          status: "queued",
          conclusion: null,
          run_started_at: null,
          html_url: "https://example.com/run/2",
          updated_at: "2026-01-01T00:00:00Z",
        },
      });
      listJobsForWorkflowRun.mockResolvedValue({
        data: {
          jobs: [
            { name: "build", status: "queued", steps: [] },
            { name: "deploy", status: "queued", steps: [] },
          ],
        },
      });

      const { fetchRunProgress } = await import("./github");
      const progress = await fetchRunProgress(2);

      expect(progress.currentJobName).toBe("build");
      expect(progress.stepsTotal).toBe(0);
    });

    it("defaults to null job/step and queued status when there are no jobs", async () => {
      getWorkflowRun.mockResolvedValue({
        data: {
          status: undefined,
          conclusion: undefined,
          run_started_at: undefined,
          html_url: "https://example.com/run/3",
          updated_at: "2026-01-01T00:00:00Z",
        },
      });
      listJobsForWorkflowRun.mockResolvedValue({ data: { jobs: [] } });

      const { fetchRunProgress } = await import("./github");
      const progress = await fetchRunProgress(3);

      expect(progress.currentJobName).toBeNull();
      expect(progress.currentStepName).toBeNull();
      expect(progress.runStatus).toBe("queued");
      expect(progress.runConclusion).toBeNull();
      expect(progress.runStartedAt).toBeNull();
    });
  });

  describe("fetchRunSteps", () => {
    it("flattens steps across jobs, in order, mapping each field", async () => {
      listJobsForWorkflowRun.mockResolvedValue({
        data: {
          jobs: [
            {
              name: "build",
              steps: [
                {
                  name: "checkout",
                  status: "completed",
                  conclusion: "success",
                  started_at: "2026-01-01T00:00:00Z",
                  completed_at: "2026-01-01T00:00:05Z",
                },
              ],
            },
            {
              name: "deploy",
              steps: [
                {
                  name: "terraform apply",
                  status: "in_progress",
                  conclusion: null,
                  started_at: "2026-01-01T00:01:00Z",
                  completed_at: null,
                },
                {
                  name: "notify",
                  status: "queued",
                  conclusion: null,
                  started_at: null,
                  completed_at: null,
                },
              ],
            },
          ],
        },
      });

      const { fetchRunSteps } = await import("./github");
      const steps = await fetchRunSteps(1);

      expect(steps).toEqual([
        {
          name: "checkout",
          status: "completed",
          conclusion: "success",
          startedAt: "2026-01-01T00:00:00Z",
          completedAt: "2026-01-01T00:00:05Z",
        },
        {
          name: "terraform apply",
          status: "in_progress",
          conclusion: null,
          startedAt: "2026-01-01T00:01:00Z",
          completedAt: null,
        },
        {
          name: "notify",
          status: "queued",
          conclusion: null,
          startedAt: null,
          completedAt: null,
        },
      ]);
    });

    it("treats a job with no steps property as contributing zero steps", async () => {
      listJobsForWorkflowRun.mockResolvedValue({
        data: { jobs: [{ name: "build" }, { name: "deploy", steps: [] }] },
      });

      const { fetchRunSteps } = await import("./github");
      const steps = await fetchRunSteps(1);

      expect(steps).toEqual([]);
    });

    it("returns an empty array when the run has no jobs", async () => {
      listJobsForWorkflowRun.mockResolvedValue({ data: { jobs: [] } });

      const { fetchRunSteps } = await import("./github");
      expect(await fetchRunSteps(1)).toEqual([]);
    });

    it("requests only the latest attempt for the given run", async () => {
      listJobsForWorkflowRun.mockResolvedValue({ data: { jobs: [] } });

      const { fetchRunSteps } = await import("./github");
      await fetchRunSteps(42);

      expect(listJobsForWorkflowRun).toHaveBeenCalledWith(
        expect.objectContaining({
          owner: "acme",
          repo: "chatbot",
          run_id: 42,
          filter: "latest",
        }),
      );
    });
  });

  describe("findRunForDeployment", () => {
    it("matches a run whose display_title contains the deployment id", async () => {
      listWorkflowRuns.mockResolvedValue({
        data: {
          workflow_runs: [
            { id: 10, display_title: "deploy unrelated-id", html_url: "https://x/10" },
            { id: 11, display_title: "deploy dep-abc123", html_url: "https://x/11" },
          ],
        },
      });

      const { findRunForDeployment } = await import("./github");
      const result = await findRunForDeployment(
        "dep-abc123",
        new Date("2026-01-01T00:10:00Z"),
        "deploy-tenant.yml",
      );

      expect(result).toEqual({ runId: 11, htmlUrl: "https://x/11" });
    });

    it("returns null when no run matches", async () => {
      listWorkflowRuns.mockResolvedValue({ data: { workflow_runs: [] } });

      const { findRunForDeployment } = await import("./github");
      const result = await findRunForDeployment("dep-missing", new Date(), "deploy-tenant.yml");

      expect(result).toBeNull();
    });

    it("queries with a 5-minute clock-skew buffer before startedAt", async () => {
      listWorkflowRuns.mockResolvedValue({ data: { workflow_runs: [] } });

      const { findRunForDeployment } = await import("./github");
      await findRunForDeployment("dep-x", new Date("2026-01-01T00:10:00Z"), "deploy-tenant.yml");

      expect(listWorkflowRuns).toHaveBeenCalledWith(
        expect.objectContaining({ created: ">=2026-01-01T00:05:00.000Z" }),
      );
    });

    it("searches the workflow file passed in, not a hardcoded one", async () => {
      listWorkflowRuns.mockResolvedValue({ data: { workflow_runs: [] } });

      const { findRunForDeployment } = await import("./github");
      await findRunForDeployment("dep-x", new Date(), "destroy-tenant.yml");

      expect(listWorkflowRuns).toHaveBeenCalledWith(
        expect.objectContaining({ workflow_id: "destroy-tenant.yml" }),
      );
    });
  });

  describe("fetchDeploymentOutputsArtifact", () => {
    it("downloads and unzips the matching artifact", async () => {
      listWorkflowRunArtifacts.mockResolvedValue({
        data: { artifacts: [{ id: 42, name: "deployment-outputs-dep-1", expired: false }] },
      });
      downloadArtifact.mockResolvedValue({
        data: zipWithOutputs({ chatbotUrl: "https://chat.example.com", albDnsName: "alb.example.com" }),
      });

      const { fetchDeploymentOutputsArtifact } = await import("./github");
      const result = await fetchDeploymentOutputsArtifact(123);

      expect(result).toEqual({ chatbotUrl: "https://chat.example.com", albDnsName: "alb.example.com" });
      expect(downloadArtifact).toHaveBeenCalledWith(
        expect.objectContaining({ artifact_id: 42, archive_format: "zip" }),
      );
    });

    it("returns null when no matching artifact exists", async () => {
      listWorkflowRunArtifacts.mockResolvedValue({ data: { artifacts: [] } });

      const { fetchDeploymentOutputsArtifact } = await import("./github");
      const result = await fetchDeploymentOutputsArtifact(123);

      expect(result).toBeNull();
      expect(downloadArtifact).not.toHaveBeenCalled();
    });

    it("ignores an expired artifact and returns null", async () => {
      listWorkflowRunArtifacts.mockResolvedValue({
        data: { artifacts: [{ id: 42, name: "deployment-outputs-dep-1", expired: true }] },
      });

      const { fetchDeploymentOutputsArtifact } = await import("./github");
      const result = await fetchDeploymentOutputsArtifact(123);

      expect(result).toBeNull();
      expect(downloadArtifact).not.toHaveBeenCalled();
    });

    it("throws when the artifact's outputs.json is malformed", async () => {
      listWorkflowRunArtifacts.mockResolvedValue({
        data: { artifacts: [{ id: 42, name: "deployment-outputs-dep-1", expired: false }] },
      });
      const zip = new AdmZip();
      zip.addFile("outputs.json", Buffer.from("not json"));
      downloadArtifact.mockResolvedValue({ data: zip.toBuffer() });

      const { fetchDeploymentOutputsArtifact } = await import("./github");
      await expect(fetchDeploymentOutputsArtifact(123)).rejects.toThrow();
    });
  });
});
