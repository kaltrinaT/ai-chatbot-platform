"use client";

/**
 * The one-click bootstrap, and the check that says whether it worked.
 *
 * Together these replace the part of onboarding that failed most often: the
 * operator composing an IAM trust policy in the AWS console, or running two
 * `az` commands, with no feedback until a deploy failed half an hour later.
 * Now the console opens on a filled-in review page, and a check that takes
 * seconds says whether the customer's cloud actually trusts this platform.
 *
 * Both panels keep the manual instructions, folded away. A customer whose
 * policy forbids the console's quick-create flow, or who wants to read what
 * they are about to create before they create it, still needs them — and they
 * are the authoritative description of what the templates build.
 */

import { useState, useTransition } from "react";
import { CheckCircle2, ExternalLink, KeyRound, Loader2, ShieldCheck, XCircle } from "lucide-react";
import {
  AZURE_FEDERATION_AUDIENCE,
  GITHUB_OIDC_ISSUER,
  azureFederatedCredentialCommand,
  azureFederatedSubject,
  azureManagedIdentityCredentialCommand,
  type GithubRepo,
} from "@/lib/azureFederation";
import { awsExternalId, awsFederatedSubject, awsTrustPolicy } from "@/lib/awsTrust";
import {
  awsQuickCreateUrl,
  awsStateBucketCommands,
  awsUpdateStackCommand,
  azureBootstrapCommand,
  azureBootstrapParameters,
  azureDeployUrl,
  azureStateStorageCommands,
} from "@/lib/bootstrapLinks";
import { pollCheck, startCheck, type StartedCheck } from "@/app/tenants/connectionActions";
import { CONNECTION_CHECK_FIELDS, type ConnectionCheck } from "@/lib/verifyConnection";
import { CopyableValue } from "./fields";

/** How often to ask GitHub whether the check has finished. */
const POLL_INTERVAL_MS = 3000;
/** Stop polling well after the workflow's own 5-minute timeout. */
const POLL_TIMEOUT_MS = 8 * 60_000;

export type BootstrapContext = {
  githubRepo: GithubRepo | null;
  platformAccountId: string | null;
  templateBaseUrl: string | null;
};

function BootstrapButton({ href, label }: { href: string; label: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
    >
      {label}
      <ExternalLink className="h-3.5 w-3.5" />
    </a>
  );
}

function Panel({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-5 rounded-lg border border-blue-100 bg-blue-50/60 p-4">
      <div className="flex items-start gap-3">
        <KeyRound className="mt-0.5 h-4 w-4 shrink-0 text-blue-600" />
        <div className="min-w-0 flex-1 text-xs text-gray-600">{children}</div>
      </div>
    </div>
  );
}

/**
 * Why the buttons are missing, in terms of the setting that would bring them
 * back. Silence here would look like the feature does not exist.
 */
function MissingConfig({ what }: { what: string }) {
  return (
    <p className="mt-2 rounded border border-amber-200 bg-amber-50 p-2 text-amber-800">
      {what} The manual steps below do the same thing.
    </p>
  );
}

// ── AWS ───────────────────────────────────────────────────────────────────

export function AwsBootstrapPanel({
  githubRepo,
  platformAccountId,
  templateBaseUrl,
  tenantId,
  tenantSlug,
  awsAccountId,
  awsRegion,
  existingStack = false,
}: BootstrapContext & {
  tenantId: string;
  tenantSlug: string;
  awsAccountId: string;
  awsRegion: string;
  /**
   * The tenant already exists, so its stack does too. A stack created before
   * the template gained the Terraform state bucket has to be updated, which a
   * Quick Create link cannot do.
   */
  existingStack?: boolean;
}) {
  // Every one of these ends up in the link, and a link built from a blank is
  // a stack the customer has to fill in by hand — worse than no link, because
  // it looks complete.
  const ready = Boolean(templateBaseUrl && platformAccountId && githubRepo && tenantSlug && awsRegion);

  return (
    <Panel>
      <p>
        <span className="font-medium text-gray-900">No access key is shared with the platform.</span>{" "}
        Deployments sign in to this account through GitHub&apos;s identity provider and receive
        credentials that last only as long as the run. Create the role that allows it below.
      </p>

      {existingStack && templateBaseUrl && tenantSlug && awsRegion && (
        <div className="mt-3">
          <p className="font-medium text-gray-900">Bootstrapped before the state bucket existed?</p>
          <p className="mt-1">
            The template now also creates the bucket that keeps this chatbot&apos;s Terraform state in
            this account instead of with the platform. Update the existing stack once with this
            command, which keeps every value it was created with. The next deploy moves the state
            into the bucket, and <span className="font-medium">Test connection</span> confirms the
            bucket exists before then.
          </p>
          <dl className="mt-2 space-y-2">
            <CopyableValue
              label="Update the stack"
              value={awsUpdateStackCommand({ templateBaseUrl, tenantSlug, region: awsRegion })}
            />
          </dl>
        </div>
      )}

      {ready ? (
        <div className="mt-3">
          <BootstrapButton
            href={awsQuickCreateUrl({
              templateBaseUrl: templateBaseUrl!,
              tenantId,
              tenantSlug,
              githubRepo: githubRepo!,
              platformAccountId: platformAccountId!,
              region: awsRegion,
            })}
            label="Configure AWS account"
          />
          <p className="mt-2 text-[11px] text-gray-500">
            Opens the AWS console on a CloudFormation stack with every value filled in. Review what
            it creates, press <span className="font-medium">Create stack</span>, then copy the
            role ARN from its Outputs tab back into the field above.
          </p>
        </div>
      ) : (
        <MissingConfig
          what={
            !templateBaseUrl
              ? "PLATFORM_BOOTSTRAP_TEMPLATE_BASE_URL is not set, so the one-click setup is unavailable."
              : !platformAccountId
                ? "PLATFORM_AWS_ACCOUNT_ID is not set, so the one-click setup is unavailable."
                : !githubRepo
                  ? "CHATBOT_REPO_OWNER / CHATBOT_REPO_NAME are not set, so the one-click setup is unavailable."
                  : "Fill in the region and short name above to enable the one-click setup."
          }
        />
      )}

      <details className="mt-3">
        <summary className="cursor-pointer font-medium text-blue-700">
          Or create the role by hand
        </summary>
        <p className="mt-2">
          Create an IAM role named{" "}
          <span className="font-mono">chatbot-client-deploy-{tenantSlug || "<slug>"}</span> with this
          trust policy and the permissions listed in the deployment guide. The first statement lets
          this chatbot&apos;s deployments in; the second lets the platform store this chatbot&apos;s
          API keys in your Secrets Manager during onboarding, and nothing else.
        </p>
        <dl className="mt-3 space-y-2">
          <CopyableValue
            label="Trust policy"
            value={awsTrustPolicy({
              platformAccountId,
              customerAccountId: awsAccountId || null,
              githubRepo,
              tenantId,
            })}
          />
          <CopyableValue label="External ID" value={awsExternalId(tenantId)} />
          {githubRepo && (
            <CopyableValue label="Federated subject" value={awsFederatedSubject(githubRepo, tenantId)} />
          )}
        </dl>
        <p className="mt-3">
          Deployments also keep this chatbot&apos;s Terraform state in a bucket in your account. Its
          name ends in your account-regional suffix, so no other AWS account can register it. The
          template additionally expires old state versions after 30 days and refuses non-TLS access.
        </p>
        <dl className="mt-2 space-y-2">
          <CopyableValue
            label="State bucket"
            value={awsStateBucketCommands({
              tenantSlug: tenantSlug || "<slug>",
              awsAccountId: awsAccountId || "<account-id>",
              region: awsRegion || "<region>",
            })}
          />
        </dl>
      </details>
    </Panel>
  );
}

// ── Azure ─────────────────────────────────────────────────────────────────

export function AzureBootstrapPanel({
  githubRepo,
  templateBaseUrl,
  tenantId,
  tenantSlug,
  clientId,
  azureRegion,
  subscriptionId = "",
  existingDeployment = false,
}: BootstrapContext & {
  tenantId: string;
  tenantSlug: string;
  clientId: string;
  azureRegion: string;
  subscriptionId?: string;
  /**
   * The tenant already exists. A bootstrap run before the template gained
   * the Terraform state storage has to be run again, which adds it and leaves
   * everything else as it is.
   */
  existingDeployment?: boolean;
}) {
  if (!githubRepo) {
    return (
      <p
        role="alert"
        className="mt-5 rounded-lg border border-amber-200 bg-amber-50 p-4 text-xs text-amber-800"
      >
        The platform does not know which repository its deployments run from, so it cannot show the
        federated credential this tenant needs. Set CHATBOT_REPO_OWNER and CHATBOT_REPO_NAME.
      </p>
    );
  }

  const parameters = azureBootstrapParameters({
    tenantId,
    tenantSlug,
    githubRepo,
    region: azureRegion || "westeurope",
  });

  return (
    <Panel>
      <p>
        <span className="font-medium text-gray-900">No secret is shared with the platform.</span>{" "}
        Deployments exchange a token signed by GitHub for an Azure token, and nothing reusable is
        stored anywhere. Create the identity that allows it below.
      </p>

      {existingDeployment && templateBaseUrl && tenantSlug && azureRegion && (
        <div className="mt-3">
          <p className="font-medium text-gray-900">Bootstrapped before the state storage existed?</p>
          <p className="mt-1">
            The template now also creates the storage account that keeps this chatbot&apos;s
            Terraform state in this subscription instead of with the platform. Run the bootstrap
            again, with the button below or this command. Every resource in it is declared by name,
            so it adds what is missing and leaves the rest as it is. The next deploy moves the state
            into it, and <span className="font-medium">Test connection</span> confirms it is ready
            before then.
          </p>
          <dl className="mt-2 space-y-2">
            <CopyableValue
              label="Run the bootstrap again"
              value={azureBootstrapCommand({ templateBaseUrl, tenantId, tenantSlug, githubRepo, region: azureRegion })}
            />
          </dl>
        </div>
      )}

      {templateBaseUrl ? (
        <div className="mt-3">
          <BootstrapButton href={azureDeployUrl(templateBaseUrl)} label="Configure Azure" />
          <p className="mt-2 text-[11px] text-gray-500">
            Opens the Azure portal on a template that creates the resource group, the deployment
            identity, its trust in GitHub, and the storage for the chatbot&apos;s Terraform state.
            The portal cannot take values from a link, so enter these, then copy the client ID from
            the deployment&apos;s Outputs back into the field above.
          </p>
          <dl className="mt-3 space-y-2">
            {parameters.map((p) => (
              <CopyableValue key={p.name} label={p.label} value={p.value} />
            ))}
          </dl>
        </div>
      ) : (
        <MissingConfig what="PLATFORM_BOOTSTRAP_TEMPLATE_BASE_URL is not set, so the one-click setup is unavailable." />
      )}

      <details className="mt-3">
        <summary className="cursor-pointer font-medium text-blue-700">
          Or create the credential by hand
        </summary>
        <p className="mt-2">
          Add a federated credential to an identity of your own with exactly these values. It trusts
          this chatbot&apos;s deployments only: any other tenant&apos;s deployment carries a
          different subject and is refused by Microsoft Entra ID.
        </p>
        <dl className="mt-3 space-y-2">
          <CopyableValue label="Issuer" value={GITHUB_OIDC_ISSUER} />
          <CopyableValue label="Subject" value={azureFederatedSubject(githubRepo, tenantId)} />
          <CopyableValue label="Audience" value={AZURE_FEDERATION_AUDIENCE} />
        </dl>
        <p className="mt-3">
          Going this route means creating the resource group{" "}
          <span className="font-mono">chatbot-{tenantSlug || "<slug>"}</span> yourself and granting
          the identity Contributor and User Access Administrator on it — the template does both.
        </p>
        <dl className="mt-2 space-y-2">
          <CopyableValue
            label="App registration"
            value={azureFederatedCredentialCommand(githubRepo, tenantId, clientId)}
          />
          <CopyableValue
            label="Managed identity"
            value={azureManagedIdentityCredentialCommand(githubRepo, tenantId)}
          />
        </dl>
        <p className="mt-3">
          Deployments also keep this chatbot&apos;s Terraform state in a storage account in the same
          resource group, which accepts only Entra ID sign-in. Your identity needs a data role on its
          state container, which the last command grants. Run that one even with the template if
          your deployment identity is not the one the template created. The template additionally
          expires old state versions after 30 days.
        </p>
        <dl className="mt-2 space-y-2">
          <CopyableValue
            label="State storage"
            value={azureStateStorageCommands({
              tenantSlug: tenantSlug || "<slug>",
              region: azureRegion || "<region>",
              clientId: clientId || "<client-id>",
              subscriptionId: subscriptionId || "<subscription-id>",
            })}
          />
        </dl>
      </details>
    </Panel>
  );
}

// ── The check ─────────────────────────────────────────────────────────────

/**
 * Runs the verify workflow and reports what it found.
 *
 * `getValues` rather than props, because the wizard holds its answers in its
 * own state and the check needs whatever is in the fields at the moment the
 * button is pressed — not what was there when this component last rendered.
 */
export function ConnectionCheckPanel({ getValues }: { getValues: () => Record<string, string> }) {
  const [state, setState] = useState<ConnectionCheck | { status: "idle" } | { status: "error"; reason: string }>({
    status: "idle",
  });
  const [isPending, startTransition] = useTransition();

  function run() {
    startTransition(async () => {
      setState({ status: "pending", runUrl: null });

      // Only the fields the check needs. The wizard's state also holds the
      // customer's LLM and Pinecone keys, and sending those to an action that
      // never reads them would leak them into request logs for no reason —
      // see CONNECTION_CHECK_FIELDS.
      const values = getValues();
      const formData = new FormData();
      for (const key of CONNECTION_CHECK_FIELDS) {
        if (values[key]) formData.set(key, values[key]);
      }

      let started: StartedCheck;
      try {
        started = await startCheck(null, formData);
      } catch {
        setState({ status: "error", reason: "Could not reach the platform to start the check." });
        return;
      }

      if ("error" in started) {
        setState({ status: "error", reason: started.error });
        return;
      }

      const deadline = Date.now() + POLL_TIMEOUT_MS;
      // Sequential awaits rather than an interval: overlapping polls would
      // pile up requests whenever GitHub is slow, which is exactly when the
      // check is still running.
      for (;;) {
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));

        let result: ConnectionCheck;
        try {
          result = await pollCheck(started.checkId, started.startedAt, started.cloudProvider);
        } catch {
          setState({ status: "error", reason: "Could not reach the platform to read the result." });
          return;
        }

        setState(result);
        if (result.status !== "pending") return;

        if (Date.now() > deadline) {
          setState({
            status: "unknown",
            runUrl: result.runUrl,
            reason: "The check is taking longer than expected. Its GitHub Actions run has the latest.",
          });
          return;
        }
      }
    });
  }

  const runUrl = "runUrl" in state ? state.runUrl : null;

  return (
    <div className="mt-5 rounded-lg border border-gray-200 bg-white p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-start gap-3">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-gray-500" />
          <div className="text-xs text-gray-600">
            <p className="font-medium text-gray-900">Test the connection before deploying</p>
            <p className="mt-0.5">
              Signs in to the cloud exactly as a deployment would, and changes nothing. It takes a
              few seconds and can be repeated as often as you like.
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={run}
          disabled={isPending}
          className="shrink-0 rounded-lg border px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {isPending ? "Testing…" : "Test connection"}
        </button>
      </div>

      {state.status !== "idle" && (
        <div
          role="status"
          className={`mt-3 flex items-start gap-2 rounded border p-3 text-xs ${
            state.status === "connected"
              ? "border-green-200 bg-green-50 text-green-800"
              : state.status === "failed" || state.status === "error"
                ? "border-red-200 bg-red-50 text-red-800"
                : "border-gray-200 bg-gray-50 text-gray-700"
          }`}
        >
          {state.status === "connected" ? (
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
          ) : state.status === "failed" || state.status === "error" ? (
            <XCircle className="mt-0.5 h-4 w-4 shrink-0" />
          ) : (
            <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin" />
          )}
          <div className="min-w-0 flex-1">
            <p className="font-medium">
              {state.status === "connected"
                ? "Connected"
                : state.status === "pending"
                  ? "Checking…"
                  : state.status === "failed"
                    ? "Connection failed"
                    : "Could not tell"}
            </p>
            {"reason" in state && state.reason && <p className="mt-0.5">{state.reason}</p>}
            {runUrl && (
              <a
                href={runUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-1 inline-flex items-center gap-1 font-medium underline"
              >
                View the run
                <ExternalLink className="h-3 w-3" />
              </a>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
