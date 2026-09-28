import { describe, it, expect, beforeEach, vi } from "vitest";
import { selectWhereChain, selectJoinChain, thenableWithReturning } from "@/test/db-chains";

const {
  authMock,
  dbOwnershipWhere,
  dbReloadWhere,
  dbUpdate,
  dbUpdateSet,
  dbUpdateReturning,
  fetchRunProgress,
  findRunForDeployment,
  fetchDeploymentOutputsArtifact,
} = vi.hoisted(() => {
  const authMock = vi.fn();
  const dbOwnershipWhere = vi.fn();
  const dbReloadWhere = vi.fn();

  // .where() is awaitable directly (deployments-row update, existing
  // behavior) but also exposes .returning() (needed by reconcileCompletedRun
  // to read back `kind` for the destroy → tenants.deletedAt branch).
  const dbUpdateReturning = vi.fn();
  const dbUpdateWhere = vi.fn(() => thenableWithReturning(dbUpdateReturning));
  const dbUpdateSet = vi.fn((values: Record<string, unknown>) => {
    void values;
    return { where: dbUpdateWhere };
  });
  const dbUpdate = vi.fn(() => ({ set: dbUpdateSet }));

  const fetchRunProgress = vi.fn();
  const findRunForDeployment = vi.fn();
  const fetchDeploymentOutputsArtifact = vi.fn();

  return {
    authMock,
    dbOwnershipWhere,
    dbReloadWhere,
    dbUpdate,
    dbUpdateSet,
    dbUpdateReturning,
    fetchRunProgress,
    findRunForDeployment,
    fetchDeploymentOutputsArtifact,
  };
});

vi.mock("@/auth", () => ({ auth: authMock }));
vi.mock("@/db", () => ({
  db: {
    select: vi.fn((selection?: unknown) =>
      selection ? selectJoinChain(dbOwnershipWhere) : selectWhereChain(dbReloadWhere),
    ),
    update: dbUpdate,
  },
}));
vi.mock("@/lib/github", () => ({
  fetchRunProgress,
  findRunForDeployment,
  fetchDeploymentOutputsArtifact,
  getDeployWorkflowId: () => "deploy-tenant.yml",
  getDestroyWorkflowId: () => "destroy-tenant.yml",
}));

import { GET } from "./route";

const GRACE_MS = 60_000;
// Mirrors STALE_DEPLOYMENT_MS in route.ts: the longest workflow job timeout
// (destroy-tenant.yml, 60 minutes) plus 15 minutes of queueing margin.
const STALE_MS = (60 + 15) * 60_000;

function deploymentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "dep-1",
    tenantId: "tenant-1",
    kind: "deploy",
    status: "running",
    chatbotVersion: "v1",
    githubRunId: null,
    githubRunUrl: null,
    startedAt: new Date(),
    finishedAt: null,
    errorMessage: null,
    ...overrides,
  };
}

function runProgress(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    runStatus: "in_progress",
    runConclusion: null,
    runStartedAt: "2026-01-01T00:00:00Z",
    htmlUrl: "https://github.com/acme/chatbot/actions/runs/1",
    updatedAt: "2026-01-01T00:05:00Z",
    currentJobName: "deploy",
    currentStepName: "terraform apply",
    stepsCompleted: 1,
    stepsTotal: 3,
    ...overrides,
  };
}

function callRoute(id = "dep-1") {
  return GET({} as Request, { params: Promise.resolve({ id }) });
}

describe("GET /api/deployments/[id]/progress", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authMock.mockResolvedValue({ user: { id: "user-1" } });
    dbUpdateReturning.mockResolvedValue([deploymentRow()]);
  });

  it("returns 401 when there is no authenticated session", async () => {
    authMock.mockResolvedValue(null);

    const res = await callRoute();

    expect(res.status).toBe(401);
    expect(dbOwnershipWhere).not.toHaveBeenCalled();
  });

  it("returns 404 when the deployment doesn't belong to the session's user", async () => {
    dbOwnershipWhere.mockResolvedValue([]);

    const res = await callRoute();

    expect(res.status).toBe(404);
  });

  it("returns the deployment with live=null immediately for a terminal status", async () => {
    dbOwnershipWhere.mockResolvedValue([{ deployment: deploymentRow({ status: "succeeded" }) }]);

    const res = await callRoute();
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.deployment.status).toBe("succeeded");
    expect(json.live).toBeNull();
    expect(fetchRunProgress).not.toHaveBeenCalled();
  });

  it("merges live GitHub progress for an active deployment that already has a run id", async () => {
    dbOwnershipWhere.mockResolvedValue([
      { deployment: deploymentRow({ status: "running", githubRunId: "123" }) },
    ]);
    fetchRunProgress.mockResolvedValue(runProgress({ runStatus: "in_progress" }));

    const res = await callRoute();
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(fetchRunProgress).toHaveBeenCalledWith(123);
    expect(json.live.currentStepName).toBe("terraform apply");
    expect(json.reconciled).toBe(false);
    expect(dbUpdate).not.toHaveBeenCalled();
  });

  describe("self-healing on a completed run", () => {
    it.each([
      ["success", "succeeded"],
      ["failure", "failed"],
      ["cancelled", "cancelled"],
      [null, "failed"],
    ] as const)("maps GitHub conclusion '%s' to deployment status '%s'", async (conclusion, expectedStatus) => {
      dbOwnershipWhere.mockResolvedValue([
        { deployment: deploymentRow({ status: "running", githubRunId: "123" }) },
      ]);
      fetchRunProgress.mockResolvedValue(
        runProgress({ runStatus: "completed", runConclusion: conclusion }),
      );
      dbReloadWhere.mockResolvedValue([deploymentRow({ status: expectedStatus, githubRunId: "123" })]);

      const res = await callRoute();
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json.reconciled).toBe(true);
      expect(json.deployment.status).toBe(expectedStatus);
      expect(dbUpdateSet).toHaveBeenCalledWith(
        expect.objectContaining({ status: expectedStatus }),
      );
    });

    it("does not set an errorMessage when reconciling to succeeded", async () => {
      dbOwnershipWhere.mockResolvedValue([
        { deployment: deploymentRow({ status: "running", githubRunId: "123" }) },
      ]);
      fetchRunProgress.mockResolvedValue(runProgress({ runStatus: "completed", runConclusion: "success" }));
      dbReloadWhere.mockResolvedValue([deploymentRow({ status: "succeeded" })]);

      await callRoute();

      expect(dbUpdateSet.mock.calls[0][0]).not.toHaveProperty("errorMessage");
    });

    it("sets a descriptive errorMessage when reconciling to a failure", async () => {
      dbOwnershipWhere.mockResolvedValue([
        { deployment: deploymentRow({ status: "running", githubRunId: "123" }) },
      ]);
      fetchRunProgress.mockResolvedValue(runProgress({ runStatus: "completed", runConclusion: "failure" }));
      dbReloadWhere.mockResolvedValue([deploymentRow({ status: "failed" })]);

      await callRoute();

      expect(dbUpdateSet.mock.calls[0][0].errorMessage).toMatch(/Reconciled from GitHub/);
    });

    it("also sets tenants.deletedAt when reconciling a destroy deployment to succeeded", async () => {
      dbOwnershipWhere.mockResolvedValue([
        { deployment: deploymentRow({ kind: "destroy", status: "running", githubRunId: "123" }) },
      ]);
      fetchRunProgress.mockResolvedValue(runProgress({ runStatus: "completed", runConclusion: "success" }));
      // The .returning() from the deployments-row update — this is what tells
      // reconcileCompletedRun it just reconciled a destroy row.
      dbUpdateReturning.mockResolvedValue([
        deploymentRow({ kind: "destroy", tenantId: "tenant-1", status: "succeeded" }),
      ]);
      dbReloadWhere.mockResolvedValue([
        deploymentRow({ kind: "destroy", status: "succeeded" }),
      ]);

      await callRoute();

      // Two db.update() calls: the deployments row, then the tenants row.
      expect(dbUpdate).toHaveBeenCalledTimes(2);
      // A lost destroy webhook must not leave the secrets behind either.
      expect(dbUpdateSet).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          deletedAt: expect.any(Date),
          llmApiKeyEncrypted: null,
          pineconeApiKeyEncrypted: null,
          docsSignerSecretEncrypted: null,
          docsSignerUrl: null,
        }),
      );
      // Outputs recovery is a "deploy"-only concern — a destroy has nothing
      // to recover.
      expect(fetchDeploymentOutputsArtifact).not.toHaveBeenCalled();
    });

    it("does not touch tenants when reconciling a destroy deployment to a non-success conclusion", async () => {
      dbOwnershipWhere.mockResolvedValue([
        { deployment: deploymentRow({ kind: "destroy", status: "running", githubRunId: "123" }) },
      ]);
      fetchRunProgress.mockResolvedValue(runProgress({ runStatus: "completed", runConclusion: "failure" }));
      dbUpdateReturning.mockResolvedValue([
        deploymentRow({ kind: "destroy", tenantId: "tenant-1", status: "failed" }),
      ]);
      dbReloadWhere.mockResolvedValue([deploymentRow({ kind: "destroy", status: "failed" })]);

      await callRoute();

      expect(dbUpdate).toHaveBeenCalledTimes(1);
    });

    it("does not touch tenants when reconciling a deploy with no recoverable outputs artifact", async () => {
      dbOwnershipWhere.mockResolvedValue([
        { deployment: deploymentRow({ kind: "deploy", status: "running", githubRunId: "123" }) },
      ]);
      fetchRunProgress.mockResolvedValue(runProgress({ runStatus: "completed", runConclusion: "success" }));
      dbUpdateReturning.mockResolvedValue([
        deploymentRow({ kind: "deploy", tenantId: "tenant-1", status: "succeeded" }),
      ]);
      dbReloadWhere.mockResolvedValue([deploymentRow({ kind: "deploy", status: "succeeded" })]);
      fetchDeploymentOutputsArtifact.mockResolvedValue(null);

      await callRoute();

      expect(fetchDeploymentOutputsArtifact).toHaveBeenCalledWith(123);
      expect(dbUpdate).toHaveBeenCalledTimes(1);
    });

    it("recovers chatbotUrl/albDnsName onto tenants when reconciling a deploy to succeeded", async () => {
      dbOwnershipWhere.mockResolvedValue([
        { deployment: deploymentRow({ kind: "deploy", status: "running", githubRunId: "123" }) },
      ]);
      fetchRunProgress.mockResolvedValue(runProgress({ runStatus: "completed", runConclusion: "success" }));
      dbUpdateReturning.mockResolvedValue([
        deploymentRow({ kind: "deploy", tenantId: "tenant-1", status: "succeeded" }),
      ]);
      dbReloadWhere.mockResolvedValue([deploymentRow({ kind: "deploy", status: "succeeded" })]);
      fetchDeploymentOutputsArtifact.mockResolvedValue({
        chatbotUrl: "https://chat.example.com",
        albDnsName: "alb.example.com",
      });

      await callRoute();

      // Two db.update() calls: the deployments row, then the tenants row.
      expect(dbUpdate).toHaveBeenCalledTimes(2);
      expect(dbUpdateSet).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          chatbotUrl: "https://chat.example.com",
          albDnsName: "alb.example.com",
        }),
      );
    });

    // The artifact comes from the same workflow as the webhook, so its
    // docs-signer URL is held to the same check: the platform sends a secret
    // to whatever ends up stored there.
    describe("docsSignerUrl recovered from the artifact", () => {
      const tenantRow = {
        id: "tenant-1",
        slug: "acme",
        cloudProvider: "aws",
        awsRegion: "us-east-1",
        docsSignerUrl: null,
      };

      function reconcilingADeploy() {
        dbOwnershipWhere.mockResolvedValue([
          { deployment: deploymentRow({ kind: "deploy", status: "running", githubRunId: "123" }) },
        ]);
        fetchRunProgress.mockResolvedValue(runProgress({ runStatus: "completed", runConclusion: "success" }));
        dbUpdateReturning.mockResolvedValue([
          deploymentRow({ kind: "deploy", tenantId: "tenant-1", status: "succeeded" }),
        ]);
        // First the tenant lookup inside reconcile, then the route's reload.
        dbReloadWhere
          .mockResolvedValueOnce([tenantRow])
          .mockResolvedValueOnce([deploymentRow({ kind: "deploy", status: "succeeded" })]);
      }

      it("stores the tenant's own signer", async () => {
        reconcilingADeploy();
        fetchDeploymentOutputsArtifact.mockResolvedValue({
          docsSignerUrl: "https://abc123.lambda-url.us-east-1.on.aws/",
        });

        await callRoute();

        expect(dbUpdateSet).toHaveBeenNthCalledWith(
          2,
          expect.objectContaining({ docsSignerUrl: "https://abc123.lambda-url.us-east-1.on.aws/" }),
        );
      });

      it("drops a foreign one but still recovers the rest", async () => {
        reconcilingADeploy();
        fetchDeploymentOutputsArtifact.mockResolvedValue({
          chatbotUrl: "https://chat.example.com",
          docsSignerUrl: "https://attacker.example/collect",
        });

        await callRoute();

        const tenantUpdate = dbUpdateSet.mock.calls[1][0];
        expect(tenantUpdate).toMatchObject({ chatbotUrl: "https://chat.example.com" });
        expect(tenantUpdate).not.toHaveProperty("docsSignerUrl");
      });
    });

    it("still reports the deployment succeeded when the outputs artifact fetch throws", async () => {
      dbOwnershipWhere.mockResolvedValue([
        { deployment: deploymentRow({ kind: "deploy", status: "running", githubRunId: "123" }) },
      ]);
      fetchRunProgress.mockResolvedValue(runProgress({ runStatus: "completed", runConclusion: "success" }));
      dbUpdateReturning.mockResolvedValue([
        deploymentRow({ kind: "deploy", tenantId: "tenant-1", status: "succeeded" }),
      ]);
      dbReloadWhere.mockResolvedValue([deploymentRow({ kind: "deploy", status: "succeeded" })]);
      fetchDeploymentOutputsArtifact.mockRejectedValue(new Error("artifact expired"));

      const res = await callRoute();
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json.deployment.status).toBe("succeeded");
      // Only the deployments-row update — the failed recovery attempt never
      // reaches a tenants update.
      expect(dbUpdate).toHaveBeenCalledTimes(1);
    });
  });

  describe("missing run id", () => {
    it("returns live=null without attempting a lookup within the grace period", async () => {
      dbOwnershipWhere.mockResolvedValue([
        {
          deployment: deploymentRow({
            status: "running",
            githubRunId: null,
            startedAt: new Date(Date.now() - GRACE_MS / 2),
          }),
        },
      ]);

      const res = await callRoute();
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json.live).toBeNull();
      expect(findRunForDeployment).not.toHaveBeenCalled();
    });

    it("looks up the run by display_title once past the grace period, and adopts it", async () => {
      const startedAt = new Date(Date.now() - GRACE_MS * 2);
      dbOwnershipWhere.mockResolvedValue([
        { deployment: deploymentRow({ status: "running", githubRunId: null, startedAt }) },
      ]);
      findRunForDeployment.mockResolvedValue({ runId: 555, htmlUrl: "https://github.com/x/555" });
      dbReloadWhere.mockResolvedValue([
        deploymentRow({ status: "running", githubRunId: "555", githubRunUrl: "https://github.com/x/555", startedAt }),
      ]);
      fetchRunProgress.mockResolvedValue(runProgress({ runStatus: "in_progress" }));

      const res = await callRoute();
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(findRunForDeployment).toHaveBeenCalledWith("dep-1", startedAt, "deploy-tenant.yml");
      expect(dbUpdateSet).toHaveBeenCalledWith(
        expect.objectContaining({ githubRunId: "555", githubRunUrl: "https://github.com/x/555" }),
      );
      expect(fetchRunProgress).toHaveBeenCalledWith(555);
      expect(json.live.runStatus).toBe("in_progress");
    });

    it("looks up a destroy deployment's run on the destroy workflow, not the deploy one", async () => {
      const startedAt = new Date(Date.now() - GRACE_MS * 2);
      dbOwnershipWhere.mockResolvedValue([
        { deployment: deploymentRow({ kind: "destroy", status: "running", githubRunId: null, startedAt }) },
      ]);
      findRunForDeployment.mockResolvedValue({ runId: 777, htmlUrl: "https://github.com/x/777" });
      dbReloadWhere.mockResolvedValue([
        deploymentRow({ kind: "destroy", status: "running", githubRunId: "777", githubRunUrl: "https://github.com/x/777", startedAt }),
      ]);
      fetchRunProgress.mockResolvedValue(runProgress({ runStatus: "in_progress" }));

      await callRoute();

      expect(findRunForDeployment).toHaveBeenCalledWith("dep-1", startedAt, "destroy-tenant.yml");
    });

    it("looks up an azure tenant's deploy run on the azure workflow, not the AWS one", async () => {
      const startedAt = new Date(Date.now() - GRACE_MS * 2);
      dbOwnershipWhere.mockResolvedValue([
        {
          deployment: deploymentRow({ kind: "deploy", status: "running", githubRunId: null, startedAt }),
          cloudProvider: "azure",
        },
      ]);
      findRunForDeployment.mockResolvedValue({ runId: 888, htmlUrl: "https://github.com/x/888" });
      dbReloadWhere.mockResolvedValue([
        deploymentRow({
          kind: "deploy",
          status: "running",
          githubRunId: "888",
          githubRunUrl: "https://github.com/x/888",
          startedAt,
        }),
      ]);
      fetchRunProgress.mockResolvedValue(runProgress({ runStatus: "in_progress" }));

      await callRoute();

      expect(findRunForDeployment).toHaveBeenCalledWith("dep-1", startedAt, "deploy-tenant-azure.yml");
    });

    it("returns live=null (not stale yet) when no run can be found past the grace period", async () => {
      const startedAt = new Date(Date.now() - GRACE_MS * 2);
      dbOwnershipWhere.mockResolvedValue([
        { deployment: deploymentRow({ status: "running", githubRunId: null, startedAt }) },
      ]);
      findRunForDeployment.mockResolvedValue(null);

      const res = await callRoute();
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json.live).toBeNull();
      expect(json.reconciled).toBe(false);
      expect(dbUpdate).not.toHaveBeenCalled();
    });

    it("auto-fails the deployment once it has been un-locatable past the stale window", async () => {
      const startedAt = new Date(Date.now() - STALE_MS - 1000);
      dbOwnershipWhere.mockResolvedValue([
        { deployment: deploymentRow({ status: "running", githubRunId: null, startedAt }) },
      ]);
      findRunForDeployment.mockResolvedValue(null);
      dbReloadWhere.mockResolvedValue([
        deploymentRow({ status: "failed", githubRunId: null, startedAt, errorMessage: "no run found" }),
      ]);

      const res = await callRoute();
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json.reconciled).toBe(true);
      expect(dbUpdateSet).toHaveBeenCalledWith(
        expect.objectContaining({ status: "failed" }),
      );
    });

    // The regression the stale window's size exists to prevent. A teardown
    // waiting on CloudFront deletion can legitimately run close to its
    // 60-minute job timeout. Under the old 45-minute window, such a run was
    // failed while still running whenever its run-started callback had been
    // lost. It must survive anywhere inside the longest workflow timeout.
    it("does not fail an un-locatable teardown that is still inside the longest workflow timeout", async () => {
      const startedAt = new Date(Date.now() - 50 * 60_000);
      dbOwnershipWhere.mockResolvedValue([
        { deployment: deploymentRow({ kind: "destroy", status: "running", githubRunId: null, startedAt }) },
      ]);
      findRunForDeployment.mockResolvedValue(null);

      const res = await callRoute();
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json.reconciled).toBe(false);
      expect(findRunForDeployment).toHaveBeenCalledWith("dep-1", startedAt, "destroy-tenant.yml");
      expect(dbUpdate).not.toHaveBeenCalled();
    });
  });

  describe("GitHub API errors", () => {
    it("classifies a 404 and auto-fails the deployment once stale", async () => {
      const startedAt = new Date(Date.now() - STALE_MS - 1000);
      dbOwnershipWhere.mockResolvedValue([
        { deployment: deploymentRow({ status: "running", githubRunId: "123", startedAt }) },
      ]);
      fetchRunProgress.mockRejectedValue(Object.assign(new Error("not found"), { status: 404 }));
      dbReloadWhere.mockResolvedValue([
        deploymentRow({ status: "failed", githubRunId: "123", startedAt }),
      ]);

      const res = await callRoute();
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json.githubError).toBe("run_not_found");
      expect(json.reconciled).toBe(true);
      expect(dbUpdate).toHaveBeenCalled();
    });

    it("classifies a 404 but does not auto-fail before the stale window", async () => {
      dbOwnershipWhere.mockResolvedValue([
        { deployment: deploymentRow({ status: "running", githubRunId: "123" }) },
      ]);
      fetchRunProgress.mockRejectedValue(Object.assign(new Error("not found"), { status: 404 }));

      const res = await callRoute();
      const json = await res.json();

      expect(json.githubError).toBe("run_not_found");
      expect(json.reconciled).toBe(false);
      expect(dbUpdate).not.toHaveBeenCalled();
    });

    it.each([401, 403])("classifies a %d as a github_auth error and never auto-fails", async (status) => {
      const startedAt = new Date(Date.now() - STALE_MS - 1000);
      dbOwnershipWhere.mockResolvedValue([
        { deployment: deploymentRow({ status: "running", githubRunId: "123", startedAt }) },
      ]);
      fetchRunProgress.mockRejectedValue(Object.assign(new Error("forbidden"), { status }));

      const res = await callRoute();
      const json = await res.json();

      expect(json.githubError).toBe("github_auth");
      expect(json.reconciled).toBe(false);
      expect(dbUpdate).not.toHaveBeenCalled();
    });

    it("classifies an error with no status as github_unavailable", async () => {
      dbOwnershipWhere.mockResolvedValue([
        { deployment: deploymentRow({ status: "running", githubRunId: "123" }) },
      ]);
      fetchRunProgress.mockRejectedValue(new Error("network blip"));

      const res = await callRoute();
      const json = await res.json();

      expect(json.githubError).toBe("github_unavailable");
      expect(json.reconciled).toBe(false);
    });
  });
});
