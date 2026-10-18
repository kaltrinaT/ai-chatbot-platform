import { describe, it, expect, beforeEach, vi } from "vitest";

const github = vi.hoisted(() => ({
  createWorkflowDispatch: vi.fn(),
  findRunByMarker: vi.fn(),
  fetchRunProgress: vi.fn(),
  fetchRunSteps: vi.fn(),
  fetchFailureAnnotations: vi.fn(),
}));

vi.mock("@/lib/github", () => ({
  getChatbotRepo: () => ({ owner: "acme", repo: "chatbot" }),
  getOctokit: () => ({ actions: { createWorkflowDispatch: github.createWorkflowDispatch } }),
  findRunByMarker: github.findRunByMarker,
  fetchRunProgress: github.fetchRunProgress,
  fetchRunSteps: github.fetchRunSteps,
  fetchFailureAnnotations: github.fetchFailureAnnotations,
}));

import {
  explainSignInFailure,
  startConnectionCheck,
  pollConnectionCheck,
  verifyWorkflowId,
  CHECK_STALE_MS,
  AWS_VERIFY_WORKFLOW,
  AZURE_VERIFY_WORKFLOW,
} from "./verifyConnection";

beforeEach(() => {
  for (const fn of Object.values(github)) fn.mockReset();
  delete process.env.CHATBOT_DEPLOY_REF;
});

describe("verifyWorkflowId", () => {
  it("picks the workflow for the tenant's cloud", () => {
    expect(verifyWorkflowId("azure")).toBe(AZURE_VERIFY_WORKFLOW);
    expect(verifyWorkflowId("aws")).toBe(AWS_VERIFY_WORKFLOW);
  });
});

describe("startConnectionCheck", () => {
  it("dispatches the AWS check with the role to assume, on main by default", async () => {
    const before = Date.now();
    const result = await startConnectionCheck(
      {
        cloudProvider: "aws",
        tenantId: "t-1",
        tenantSlug: "acme",
        awsRegion: "eu-west-1",
        deploymentRoleArn: "arn:aws:iam::123:role/deployer",
      },
      "check-1",
    );

    expect(result.checkId).toBe("check-1");
    expect(result.startedAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(github.createWorkflowDispatch).toHaveBeenCalledWith({
      owner: "acme",
      repo: "chatbot",
      workflow_id: AWS_VERIFY_WORKFLOW,
      ref: "main",
      inputs: {
        check_id: "check-1",
        tenant_id: "t-1",
        tenant_slug: "acme",
        aws_region: "eu-west-1",
        deployment_role_arn: "arn:aws:iam::123:role/deployer",
      },
    });
  });

  it("dispatches the Azure check with the identity to sign in as, on the configured ref", async () => {
    process.env.CHATBOT_DEPLOY_REF = "release";
    await startConnectionCheck(
      {
        cloudProvider: "azure",
        tenantId: "t-2",
        tenantSlug: "hr",
        azureClientId: "client",
        azureTenantId: "aad",
        azureSubscriptionId: "sub",
      },
      "check-2",
    );

    expect(github.createWorkflowDispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        workflow_id: AZURE_VERIFY_WORKFLOW,
        ref: "release",
        inputs: {
          check_id: "check-2",
          tenant_id: "t-2",
          tenant_slug: "hr",
          azure_client_id: "client",
          azure_tenant_id: "aad",
          azure_subscription_id: "sub",
        },
      }),
    );
  });
});

describe("pollConnectionCheck", () => {
  const run = { runId: 7, htmlUrl: "https://github.com/acme/chatbot/actions/runs/7" };
  const justNow = () => new Date();
  // Only failed and unknown checks carry a reason.
  const reason = (r: Awaited<ReturnType<typeof pollConnectionCheck>>) => ("reason" in r ? r.reason : undefined);

  function completedRun(conclusion: string) {
    github.findRunByMarker.mockResolvedValue(run);
    github.fetchRunProgress.mockResolvedValue({ runStatus: "completed", runConclusion: conclusion });
  }

  it("reports unknown, not failed, when GitHub cannot be reached to find the run", async () => {
    github.findRunByMarker.mockRejectedValue(new Error("ECONNRESET"));

    const result = await pollConnectionCheck("c", justNow(), "aws");

    expect(result).toMatchObject({ status: "unknown", runUrl: null });
  });

  it("is pending while a freshly dispatched run has not appeared yet", async () => {
    github.findRunByMarker.mockResolvedValue(null);

    expect(await pollConnectionCheck("c", justNow(), "aws")).toEqual({ status: "pending", runUrl: null });
    expect(github.findRunByMarker).toHaveBeenCalledWith("c", expect.any(Date), AWS_VERIFY_WORKFLOW);
  });

  it("gives up on a run that never appeared within the stale window", async () => {
    github.findRunByMarker.mockResolvedValue(null);
    const longAgo = new Date(Date.now() - CHECK_STALE_MS - 1000);

    const result = await pollConnectionCheck("c", longAgo, "azure");

    expect(result.status).toBe("failed");
    expect(reason(result)).toMatch(/no workflow run appeared/);
  });

  it("reports unknown with the run's link when its progress cannot be read", async () => {
    github.findRunByMarker.mockResolvedValue(run);
    github.fetchRunProgress.mockRejectedValue(new Error("502"));

    const result = await pollConnectionCheck("c", justNow(), "aws");

    expect(result).toMatchObject({ status: "unknown", runUrl: run.htmlUrl });
  });

  it("is pending while the run is still going", async () => {
    github.findRunByMarker.mockResolvedValue(run);
    github.fetchRunProgress.mockResolvedValue({ runStatus: "in_progress", runConclusion: null });

    expect(await pollConnectionCheck("c", justNow(), "aws")).toEqual({ status: "pending", runUrl: run.htmlUrl });
  });

  it("is connected when the sign-in run succeeded", async () => {
    completedRun("success");

    expect(await pollConnectionCheck("c", justNow(), "aws")).toEqual({ status: "connected", runUrl: run.htmlUrl });
  });

  it("blames the GitHub environment when the run failed without starting a step", async () => {
    completedRun("failure");
    github.fetchRunSteps.mockResolvedValue([]);

    const result = await pollConnectionCheck("c", justNow(), "azure");

    expect(result.status).toBe("failed");
    expect(reason(result)).toMatch(/never started/);
  });

  it("treats unreadable steps the same as none", async () => {
    completedRun("failure");
    github.fetchRunSteps.mockRejectedValue(new Error("502"));

    const result = await pollConnectionCheck("c", justNow(), "aws");

    expect(reason(result)).toMatch(/never started/);
    expect(github.fetchFailureAnnotations).not.toHaveBeenCalled();
  });

  it("explains a known sign-in error from the run's annotations", async () => {
    completedRun("failure");
    github.fetchRunSteps.mockResolvedValue([{ name: "Sign in to Azure", conclusion: "failure" }]);
    github.fetchFailureAnnotations.mockResolvedValue(["AADSTS700016: Application not found"]);

    const result = await pollConnectionCheck("c", justNow(), "azure");

    expect(reason(result)).toMatch(/No identity with this client ID exists/);
  });

  it("falls back to the failing step's name when the error is not a known one", async () => {
    completedRun("failure");
    github.fetchRunSteps.mockResolvedValue([
      { name: "Check out", conclusion: "success" },
      { name: "Assume the deployment role", conclusion: "failure" },
    ]);
    github.fetchFailureAnnotations.mockResolvedValue(["Process completed with exit code 1."]);

    const result = await pollConnectionCheck("c", justNow(), "aws");

    expect(reason(result)).toBe("Failed at: Assume the deployment role. Its GitHub Actions log has the exact error.");
  });

  it("still names the step when the annotations cannot be read", async () => {
    completedRun("cancelled");
    github.fetchRunSteps.mockResolvedValue([{ name: "Assume the deployment role", conclusion: "failure" }]);
    github.fetchFailureAnnotations.mockRejectedValue(new Error("403"));

    const result = await pollConnectionCheck("c", justNow(), "aws");

    expect(reason(result)).toMatch(/^Failed at: Assume the deployment role/);
  });

  it("says only that the check failed when no step is marked as the failure", async () => {
    completedRun("failure");
    github.fetchRunSteps.mockResolvedValue([{ name: "Check out", conclusion: "cancelled" }]);
    github.fetchFailureAnnotations.mockResolvedValue([]);

    const result = await pollConnectionCheck("c", justNow(), "aws");

    expect(reason(result)).toBe("The connection check failed. Its GitHub Actions log has the reason.");
  });
});

// The messages below are what the verify workflows' failed runs actually
// reported, as GitHub's annotations carry them.
describe("explainSignInFailure", () => {
  it("names an identity with no federated credential — an old app registration", () => {
    const reason = explainSignInFailure([
      "Login failed with Error: The process '/usr/bin/az' failed with exit code 1.",
      "AADSTS70025: The client '***'(ai-chatbot-deployer) has no configured federated identity credentials. Trace ID: d6e5f9cc",
    ]);
    expect(reason).toMatch(/no federated credential/);
    expect(reason).toMatch(/clientId output of this chatbot's setup/);
  });

  it("names an identity whose credential trusts a different chatbot", () => {
    const reason = explainSignInFailure([
      "AADSTS700213: No matching federated identity record found for presented assertion subject 'repo:o/r:environment:tenant-x'.",
    ]);
    expect(reason).toMatch(/trusts a different chatbot/);
  });

  it("names an AWS role that does not trust this chatbot", () => {
    const reason = explainSignInFailure([
      "Could not assume role with OIDC: Not authorized to perform sts:AssumeRoleWithWebIdentity",
    ]);
    expect(reason).toMatch(/does not trust this chatbot's deployments/);
  });

  it("names an AWS account with no GitHub identity provider", () => {
    const reason = explainSignInFailure([
      "Could not assume role with OIDC: No OpenIDConnect provider found in your account for https://token.actions.githubusercontent.com",
    ]);
    expect(reason).toMatch(/not registered GitHub as an identity provider/);
  });

  // Anything else keeps the step name, rather than a guess.
  it("offers nothing for an error it does not know", () => {
    expect(explainSignInFailure(["Process completed with exit code 1."])).toBeNull();
    expect(explainSignInFailure([])).toBeNull();
  });
});
