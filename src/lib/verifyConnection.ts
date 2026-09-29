/**
 * "Does this customer's cloud actually trust us yet?"
 *
 * Onboarding asks the customer to create an identity in their own cloud and
 * grant it to this platform's workflows. Until this check runs, nothing on
 * either side has tested whether they did it correctly — and the first thing
 * that would test it is a real deploy, half an hour in, after images have been
 * replicated into their registry. The failure then reads as a deployment
 * problem rather than the setup problem it is.
 *
 * The check is a workflow that signs in and does nothing else: it assumes the
 * role, or exchanges the token, and stops. Read-only, seconds long, and free
 * to repeat. Crucially it runs in the same GitHub environment a deploy runs
 * in, so the token it presents carries exactly the subject a deploy would
 * carry — a check that logged in some other way would prove nothing about
 * whether deploys will work.
 *
 * Nothing is written to the database. The check describes a fact about the
 * customer's cloud at one moment, and that fact can change without the
 * platform being told — a deleted credential, a revoked role assignment — so a
 * stored "Connected ✓" would age into a claim the platform cannot stand
 * behind. It also means this works before the tenant row exists, which is what
 * lets the wizard verify a customer's setup before creating anything.
 */

import {
  getChatbotRepo,
  getOctokit,
  fetchFailureAnnotations,
  fetchRunProgress,
  fetchRunSteps,
  findRunByMarker,
} from "@/lib/github";
import type { ConnectionCheck } from "@/lib/connectionCheck";

export const AWS_VERIFY_WORKFLOW = "verify-tenant-aws.yml";
export const AZURE_VERIFY_WORKFLOW = "verify-tenant-azure.yml";

export function verifyWorkflowId(cloudProvider: string): string {
  return cloudProvider === "azure" ? AZURE_VERIFY_WORKFLOW : AWS_VERIFY_WORKFLOW;
}

export type AwsVerifyTarget = {
  cloudProvider: "aws";
  tenantId: string;
  tenantSlug: string;
  awsRegion: string;
  deploymentRoleArn: string;
};

export type AzureVerifyTarget = {
  cloudProvider: "azure";
  tenantId: string;
  tenantSlug: string;
  azureClientId: string;
  azureTenantId: string;
  azureSubscriptionId: string;
};

export type VerifyTarget = AwsVerifyTarget | AzureVerifyTarget;

// Shared with the onboarding wizard, which runs in the browser and so must not
// import this module (see connectionCheck.ts).
export { CONNECTION_CHECK_FIELDS, type ConnectionCheck } from "@/lib/connectionCheck";

/**
 * A run still not found this long after dispatch is treated as lost rather
 * than slow. Generous next to the job's own 5-minute timeout, because a
 * dispatched run can sit queued before any job starts.
 */
export const CHECK_STALE_MS = 10 * 60_000;

function buildInputs(target: VerifyTarget, checkId: string): Record<string, string> {
  const common = {
    check_id: checkId,
    tenant_id: target.tenantId,
    tenant_slug: target.tenantSlug,
  };

  return target.cloudProvider === "azure"
    ? {
        ...common,
        azure_client_id: target.azureClientId,
        azure_tenant_id: target.azureTenantId,
        azure_subscription_id: target.azureSubscriptionId,
      }
    : {
        ...common,
        aws_region: target.awsRegion,
        deployment_role_arn: target.deploymentRoleArn,
      };
}

/**
 * Dispatch the check. Returns the ID the run will carry in its name, which is
 * the only handle on it — workflow_dispatch tells the caller nothing about the
 * run it started.
 */
export async function startConnectionCheck(
  target: VerifyTarget,
  checkId: string,
): Promise<{ checkId: string; startedAt: Date }> {
  const { owner, repo } = getChatbotRepo();
  const ref = process.env.CHATBOT_DEPLOY_REF ?? "main";
  // Read before the dispatch, never after: a run created while this function
  // was awaiting would otherwise fall outside the window the poller searches.
  const startedAt = new Date();

  await getOctokit().actions.createWorkflowDispatch({
    owner,
    repo,
    workflow_id: verifyWorkflowId(target.cloudProvider),
    ref,
    inputs: buildInputs(target, checkId),
  });

  return { checkId, startedAt };
}

/**
 * The failing step's name, which for these workflows is the whole diagnosis:
 * each step is written so that its name describes the thing that did not
 * work. Falls back to a generic message rather than inventing a cause.
 */
function describeFailure(steps: { name: string; conclusion: string | null }[]): string {
  const failed = steps.find((s) => s.conclusion === "failure");
  if (!failed) {
    return "The connection check failed. Its GitHub Actions log has the reason.";
  }
  return `Failed at: ${failed.name}. Its GitHub Actions log has the exact error.`;
}

/**
 * The cloud's sign-in errors that have one known cause, in the operator's
 * terms. The failing step says only that the sign-in failed; the error code
 * says why, and each of these was hit in practice before it was named here.
 */
const SIGN_IN_FAILURES: { pattern: RegExp; reason: string }[] = [
  {
    pattern: /AADSTS70025\b/,
    reason:
      "The client ID belongs to an identity with no federated credential, so it is not this chatbot's setup identity — often an older app registration. Paste the clientId output of this chatbot's setup deployment.",
  },
  {
    pattern: /AADSTS700213\b|AADSTS70021\b|No matching federated identity record/,
    reason:
      "This identity trusts a different chatbot: none of its federated credentials names this chatbot's ID. Run the setup for this chatbot, and paste the clientId it outputs.",
  },
  {
    pattern: /AADSTS700016\b/,
    reason:
      "No identity with this client ID exists in the Azure AD tenant entered. Copy both from the setup deployment's outputs (clientId and azureTenantId).",
  },
  {
    pattern: /AADSTS90002\b|AADSTS900023\b/,
    reason: "The Azure AD Tenant ID was not found. Use the azureTenantId output of the setup deployment.",
  },
  {
    pattern: /No OpenIDConnect provider found/,
    reason:
      "This AWS account has not registered GitHub as an identity provider. Create the setup stack with “Register GitHub as an identity provider” set to Yes.",
  },
  {
    pattern: /Not authorized to perform sts:AssumeRoleWithWebIdentity/,
    reason:
      "The role does not trust this chatbot's deployments: its trust policy names a different chatbot, or none. Create the setup stack for this chatbot, and paste the DeploymentRoleArn it outputs.",
  },
];

/** What the run's errors say went wrong, when it is a cause named above. */
export function explainSignInFailure(messages: string[]): string | null {
  for (const { pattern, reason } of SIGN_IN_FAILURES) {
    if (messages.some((m) => pattern.test(m))) return reason;
  }
  return null;
}

/**
 * Poll once. The caller decides how often and for how long; this never
 * blocks waiting for a run to finish.
 */
export async function pollConnectionCheck(
  checkId: string,
  startedAt: Date,
  cloudProvider: string,
): Promise<ConnectionCheck> {
  const workflowId = verifyWorkflowId(cloudProvider);
  const ageMs = Date.now() - startedAt.getTime();

  let run: { runId: number; htmlUrl: string } | null;
  try {
    run = await findRunByMarker(checkId, startedAt, workflowId);
  } catch {
    // GitHub being unreachable says nothing about the customer's cloud, so it
    // must not be reported as a failed check.
    return {
      status: "unknown",
      runUrl: null,
      reason: "Could not reach GitHub to read the check's result.",
    };
  }

  if (!run) {
    if (ageMs > CHECK_STALE_MS) {
      return {
        status: "failed",
        runUrl: null,
        reason:
          "The check was dispatched but no workflow run appeared. Confirm the platform's GitHub token can dispatch workflows, and that the repository has Actions enabled.",
      };
    }
    return { status: "pending", runUrl: null };
  }

  let progress;
  try {
    progress = await fetchRunProgress(run.runId);
  } catch {
    return {
      status: "unknown",
      runUrl: run.htmlUrl,
      reason: "Could not reach GitHub to read the check's result.",
    };
  }

  if (progress.runStatus !== "completed") {
    return { status: "pending", runUrl: run.htmlUrl };
  }

  if (progress.runConclusion === "success") {
    return { status: "connected", runUrl: run.htmlUrl };
  }

  // A run that never started its job — a missing environment on a private
  // repository without the plan for it, most often — has no failing step to
  // name, so say what that actually means.
  let steps: { name: string; conclusion: string | null }[] = [];
  try {
    steps = await fetchRunSteps(run.runId);
  } catch {
    // Fall through to the generic message.
  }

  if (steps.length === 0) {
    return {
      status: "failed",
      runUrl: run.htmlUrl,
      reason:
        "The run never started. This is usually the GitHub environment: private repositories need GitHub Pro, Team or Enterprise for them, and without one the deploy identity's subject can never match.",
    };
  }

  // Best effort: the step name still says where it failed if the run's
  // annotations cannot be read.
  const explained = explainSignInFailure(await fetchFailureAnnotations(run.runId).catch(() => []));
  return { status: "failed", runUrl: run.htmlUrl, reason: explained ?? describeFailure(steps) };
}
