"use client";

import Link from "next/link";
import {
  Boxes,
  Brain,
  Cloud,
  Database,
  FileText,
  Lock,
  Settings2,
  ShieldCheck,
} from "lucide-react";
import { CloudLogo, LlmLogo, VectorStoreLogo, llmProviderLabel } from "@/app/(dashboard)/_components/ProviderLogo";
import { estimateMonthlyCost } from "@/lib/pricing";
import { azureFederatedSubject, type GithubRepo } from "@/lib/azureFederation";
import { awsExternalId, awsFederatedSubject } from "@/lib/awsTrust";
import {
  AwsBootstrapPanel,
  AzureBootstrapPanel,
  ConnectionCheckPanel,
  type BootstrapContext,
} from "./BootstrapPanel";
import {
  Card,
  CheckItem,
  ChoiceCard,
  Field,
  InfoBanner,
  NumberedItem,
  SummaryRow,
} from "./fields";

export type Values = Record<string, string>;
export type Errors = Record<string, string>;
type Setter = (key: string, value: string) => void;

type StepProps = {
  values: Values;
  set: Setter;
  errors: Errors;
};

const CLOUD_LABEL = { aws: "Amazon Web Services (AWS)", azure: "Microsoft Azure" } as const;

// ── Step 1 ────────────────────────────────────────────────────────────────

const PREREQS = {
  aws: [
    ["AWS account ID", "Your customer's 12-digit AWS account identifier (e.g. 123456789012)."],
    ["Deployment region", "The AWS region where the chatbot will be deployed (e.g. eu-central-1)."],
    [
      "IAM deployment role",
      "An IAM role with permissions to provision resources. Its name must start with chatbot-client-deploy- — the platform can only assume roles matching that prefix.",
    ],
    ["Role ARN", "The Amazon Resource Name (ARN) of that deployment role."],
    [
      "Required trust relationship",
      "The role's trust policy must allow this platform's AWS account to assume it, with an sts:ExternalId condition naming this chatbot. The next step shows the exact policy, with the value filled in.",
    ],
    ["LLM API key", "API key for the chosen LLM provider (OpenAI, Anthropic or OpenRouter)."],
    ["Pinecone API key (if selected)", "Only needed when Pinecone is the vector store."],
  ],
  azure: [
    ["Azure subscription ID", "The subscription where resources will be deployed."],
    ["Azure AD Tenant ID", "Your Microsoft Entra ID (Azure AD) directory identifier."],
    ["Deployment region", "The Azure region where the chatbot will be deployed (e.g. westeurope)."],
    [
      "Deployment identity",
      "An Entra ID app registration or a user-assigned managed identity. Only its client ID is needed — no client secret is created or shared.",
    ],
    [
      "Required permissions",
      "Contributor and User Access Administrator at subscription scope — Terraform creates the resource group and the chatbot's narrow role assignments itself.",
    ],
    [
      "Federated credential",
      "Added to that identity during the next step, from values the wizard shows. It lets this chatbot's deployments sign in, and nothing else.",
    ],
    ["LLM API key", "API key for the chosen LLM provider (OpenAI, Anthropic or OpenRouter)."],
    ["Pinecone API key (if selected)", "Only needed when Pinecone is the vector store."],
  ],
} as const;

const ONBOARDING_FLOW = [
  "Prepare cloud prerequisites",
  "Configure chatbot",
  "Choose AI settings",
  "Review estimated cost",
  "Deploy",
];

export function StepPrerequisites({ values, set }: StepProps) {
  const cloud = (values.cloudProvider ?? "aws") as "aws" | "azure";

  return (
    <div className="space-y-6">
      <InfoBanner title="Your data stays in your cloud environment" badge="Secure by design" icon={<ShieldCheck className="h-5 w-5" />}>
        The chatbot is deployed into your own cloud environment (AWS or Azure). Your documents remain
        in your data plane and are never read, copied or previewed by our control plane. We only use
        the information you provide to orchestrate the deployment.
      </InfoBanner>

      <div className="grid gap-5 lg:grid-cols-2">
        {(["aws", "azure"] as const).map((c) => {
          const selected = cloud === c;
          return (
            <section
              key={c}
              className={`rounded-xl border bg-white p-6 ${selected ? "border-blue-500 ring-1 ring-blue-500" : ""}`}
            >
              <div className="mb-5 flex items-start justify-between gap-4">
                <div className="flex items-center gap-3">
                  <CloudLogo provider={c} className="h-7 w-auto" />
                  <div>
                    <h2 className="text-base font-semibold text-gray-900">{CLOUD_LABEL[c]}</h2>
                    <p className="mt-0.5 text-sm text-gray-500">
                      Deploy your chatbot into your {c === "aws" ? "AWS account" : "Azure subscription"}.
                    </p>
                  </div>
                </div>
                {selected ? (
                  <span className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-blue-100 px-3 py-1.5 text-xs font-medium text-blue-700">
                    <ShieldCheck className="h-3.5 w-3.5" /> Selected
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={() => set("cloudProvider", c)}
                    className="shrink-0 rounded-lg border px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50"
                  >
                    Select {c === "aws" ? "AWS" : "Azure"}
                  </button>
                )}
              </div>

              <h3 className="text-sm font-semibold text-gray-900">
                Prerequisites for {c === "aws" ? "AWS" : "Azure"}
              </h3>
              <p className="mt-0.5 text-xs text-gray-500">
                Make sure you have the following ready before proceeding.
              </p>
              <ol className="mt-4 space-y-3">
                {PREREQS[c].map(([title, detail], i) => (
                  <NumberedItem key={title} n={i + 1} title={title}>
                    {detail}
                  </NumberedItem>
                ))}
              </ol>
            </section>
          );
        })}
      </div>

      <div className="rounded-xl border bg-white p-5">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-4">
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-blue-50 text-blue-600">
              <FileText className="h-5 w-5" />
            </span>
            <div>
              <div className="text-sm font-semibold text-gray-900">How onboarding works</div>
              <div className="text-xs text-gray-500">Follow these steps to deploy your chatbot.</div>
            </div>
          </div>
          <ol className="flex flex-1 flex-wrap items-center gap-x-2 gap-y-2">
            {ONBOARDING_FLOW.map((label, i) => (
              <li key={label} className="flex items-center gap-2">
                <span className="flex h-6 w-6 items-center justify-center rounded-full bg-blue-600 text-[11px] font-semibold text-white">
                  {i + 1}
                </span>
                <span className="text-xs text-gray-600">{label}</span>
                {i < ONBOARDING_FLOW.length - 1 && <span className="text-gray-300">→</span>}
              </li>
            ))}
          </ol>
        </div>
      </div>

      <p className="text-xs text-gray-500">
        Full setup instructions live in the{" "}
        <Link href="/guides/cloud-prerequisites" className="text-blue-600 hover:underline">
          cloud prerequisites guide
        </Link>
        .
      </p>
    </div>
  );
}

// ── Step 2 ────────────────────────────────────────────────────────────────

/**
 * Whether the platform has confirmed the typed slug is free. "idle" covers an
 * empty slug and one the format rules already reject.
 */
export type SlugStatus = "idle" | "checking" | "available" | "taken";

export function StepCloudConfig({
  values,
  set,
  errors,
  githubRepo,
  platformAccountId,
  templateBaseUrl,
  slugStatus = "idle",
}: StepProps & BootstrapContext & { slugStatus?: SlugStatus }) {
  const cloud = (values.cloudProvider ?? "aws") as "aws" | "azure";
  const azure = cloud === "azure";
  // The setup names cloud resources after the slug, so it is offered only once
  // the slug is known to be usable.
  const bootstrap = { githubRepo, platformAccountId, templateBaseUrl, slugReady: slugStatus === "available" };
  const slugRules = azure
    ? "3–18 chars, lowercase letters, numbers, hyphens. Limited by Azure Key Vault naming."
    : "3–21 chars, lowercase letters, numbers, hyphens. Limited by AWS target group naming.";

  return (
    <div className="space-y-6">
      <InfoBanner title="Your deployment runs inside your client's cloud environment" badge="Secure by design" icon={<ShieldCheck className="h-5 w-5" />}>
        The chatbot will be deployed into your client&apos;s {azure ? "Azure subscription" : "AWS account"}.
        Their documents remain in their environment and are never read, copied or stored by our
        control plane. We only store deployment metadata (configuration, status, IDs).
      </InfoBanner>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card title="General Information" subtitle="Basic details about this chatbot deployment." icon={<FileText className="h-5 w-5" />}>
          <div className="space-y-4">
            <Field
              label="Chatbot Name"
              required
              value={values.name ?? ""}
              onChange={(v) => set("name", v)}
              placeholder="Acme Research Assistant"
              hint='A friendly name for your chatbot (e.g. "Product Support Bot").'
              error={errors.name}
              maxLength={100}
              tooltip="The customer's display name — shown on the platform dashboard only, never used in cloud resource names."
            />
            <Field
              label="Internal Slug"
              required
              value={values.slug ?? ""}
              onChange={(v) => set("slug", v)}
              placeholder={azure ? "acme (max 18 chars for Azure)" : "acme-research-assistant"}
              hint={
                slugStatus === "checking"
                  ? "Checking that this slug is not already in use…"
                  : slugStatus === "available"
                    ? `Available. ${slugRules}`
                    : slugRules
              }
              error={errors.slug}
              maxLength={azure ? 18 : 21}
              tooltip="You choose this: a short unique ID baked into every cloud resource name (bucket, cluster, vault). It cannot be changed after creation."
            />
          </div>
        </Card>

        <div className="space-y-5">
          <Card title="Cloud Provider" subtitle="Select the cloud provider where the chatbot will be deployed." icon={<Cloud className="h-5 w-5" />}>
            <div className="grid gap-3 sm:grid-cols-2">
              {(["aws", "azure"] as const).map((c) => (
                <ChoiceCard
                  key={c}
                  name="cloudProviderChoice"
                  checked={cloud === c}
                  onSelect={() => set("cloudProvider", c)}
                  logo={<CloudLogo provider={c} className="h-5 w-auto" />}
                  title={c === "aws" ? "AWS" : "Microsoft Azure"}
                />
              ))}
            </div>

            <div className="mt-5 rounded-lg bg-gray-50 p-4">
              <h3 className="text-sm font-semibold text-gray-900">
                Why {azure ? "Azure" : "AWS"}?
              </h3>
              <ul className="mt-2 space-y-1.5 text-xs text-gray-600">
                {(azure
                  ? [
                      "Deploy into your client's Azure subscription",
                      "Container Apps, Blob Storage and Key Vault",
                      "Federated identity — no stored credential",
                    ]
                  : [
                      "Deploy into your client's AWS account",
                      "Support for S3, ECS and other AWS services",
                      "IAM role-based access with least privilege",
                    ]
                ).map((line) => (
                  <li key={line} className="flex items-start gap-2">
                    <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-blue-500" />
                    {line}
                  </li>
                ))}
              </ul>
            </div>
          </Card>

          <Card title="Deployment Options" subtitle="Which chatbot build to deploy, and where it answers from." icon={<Boxes className="h-5 w-5" />}>
            <div className="space-y-4">
              <Field
                label="Chatbot Version"
                value={values.chatbotVersion ?? ""}
                onChange={(v) => set("chatbotVersion", v)}
                placeholder="latest"
                hint="Image tag of the chatbot release to deploy."
                error={errors.chatbotVersion}
                tooltip="An image tag from the platform's chatbot releases. Use “latest” unless you were told to pin a specific release."
              />
              <Field
                label="Custom Domain (Optional)"
                value={values.domain ?? ""}
                onChange={(v) => set("domain", v)}
                placeholder="chat.acme.com"
                hint="Leave blank to use the auto-assigned URL. No https:// or trailing slash."
                error={errors.domain}
                tooltip="After the first deploy, the customer's DNS admin points a CNAME from this hostname to the chatbot URL shown on the tenant page."
              />
            </div>
          </Card>
        </div>
      </div>

      {azure ? (
        <Card title="Azure Configuration" subtitle="Provide the required Azure details for deployment." icon={<Settings2 className="h-5 w-5" />}>
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            <Field
              label="Subscription ID"
              required
              value={values.azureSubscriptionId ?? ""}
              onChange={(v) => set("azureSubscriptionId", v)}
              placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
              hint="Customer's Azure subscription ID (UUID)."
              error={errors.azureSubscriptionId}
              tooltip="Azure Portal → Subscriptions, or: az account show --query id"
            />
            <Field
              label="Azure AD Tenant ID"
              required
              value={values.azureTenantId ?? ""}
              onChange={(v) => set("azureTenantId", v)}
              placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
              hint="Entra ID tenant for the subscription."
              error={errors.azureTenantId}
              tooltip="Azure Portal → Microsoft Entra ID → Overview → Tenant ID, or: az account show --query tenantId"
            />
            <Field
              label="Deployment Region"
              required
              value={values.azureRegion ?? ""}
              onChange={(v) => set("azureRegion", v)}
              placeholder="eastus"
              hint="Azure region for all resources. Some subscriptions, such as Azure for Students, allow only a few."
              error={errors.azureRegion}
              tooltip="List them with: az account list-locations -o table"
            />
            <Field
              label="Deployment Identity Client ID"
              required
              value={values.azureClientId ?? ""}
              onChange={(v) => set("azureClientId", v)}
              placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
              hint="The clientId output of the setup deployment below, not an existing app registration."
              error={errors.azureClientId}
              tooltip="After running the setup below: the deployment's Outputs → clientId. It must be the identity whose federated credential names this chatbot; an app registration from another setup has none, and the sign-in is refused."
            />
          </div>
          <AzureBootstrapPanel
            {...bootstrap}
            tenantId={values.tenantId ?? ""}
            tenantSlug={values.slug ?? ""}
            clientId={values.azureClientId ?? ""}
            azureRegion={values.azureRegion ?? ""}
            subscriptionId={values.azureSubscriptionId ?? ""}
          />
          <ConnectionCheckPanel getValues={() => values} />
          <DocsNote />
        </Card>
      ) : (
        <Card title="AWS Configuration" subtitle="Provide the required AWS details for deployment." icon={<Settings2 className="h-5 w-5" />}
          action={
            <Link
              href="/guides/cloud-prerequisites"
              className="shrink-0 rounded-lg border px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50"
            >
              View AWS setup guide
            </Link>
          }
        >
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            <Field
              label="AWS Account ID"
              required
              value={values.awsAccountId ?? ""}
              onChange={(v) => set("awsAccountId", v)}
              placeholder="123456789012"
              hint="Your 12-digit AWS account identifier."
              error={errors.awsAccountId}
              inputMode="numeric"
              maxLength={12}
              tooltip="AWS Console account menu (top-right), or: aws sts get-caller-identity"
            />
            <Field
              label="Deployment Region"
              required
              value={values.awsRegion ?? ""}
              onChange={(v) => set("awsRegion", v)}
              placeholder="us-east-1"
              hint="Any TLS certificate must be issued in this same region."
              error={errors.awsRegion}
              tooltip="Pick the region closest to the customer's users, e.g. us-east-1, eu-central-1."
            />
            <Field
              label="IAM Deployment Role ARN"
              required
              value={values.deploymentRoleArn ?? ""}
              onChange={(v) => set("deploymentRoleArn", v)}
              placeholder="arn:aws:iam::123456789012:role/chatbot-client-deploy-acme"
              hint="The DeploymentRoleArn output of the setup stack below."
              error={errors.deploymentRoleArn}
              tooltip="The platform's IAM policy only permits assuming roles with the chatbot-client-deploy- prefix."
            />
            <Field
              label="S3 Prefix (Optional)"
              value={values.s3DocsPrefix ?? ""}
              onChange={(v) => set("s3DocsPrefix", v)}
              placeholder="chatbot/"
              hint="Optional prefix within the bucket. No leading slash."
              error={errors.s3DocsPrefix}
              tooltip="A folder path inside the docs bucket Terraform creates. Leave blank to use the bucket root."
            />
            <Field
              label="TLS Certificate ARN (Optional)"
              value={values.acmCertificateArn ?? ""}
              onChange={(v) => set("acmCertificateArn", v)}
              placeholder="arn:aws:acm:us-east-1:123456789012:certificate/…"
              hint="Needs the custom domain above. Without it, chat traffic is unencrypted."
              error={errors.acmCertificateArn}
              tooltip="Request a certificate in AWS Certificate Manager for the custom domain, in this same region, and validate it via DNS. Paste the ARN here to serve the chatbot over HTTPS; port 80 then redirects."
            />
          </div>
          <AwsBootstrapPanel
            {...bootstrap}
            tenantId={values.tenantId ?? ""}
            tenantSlug={values.slug ?? ""}
            awsAccountId={values.awsAccountId ?? ""}
            awsRegion={values.awsRegion ?? ""}
          />
          <ConnectionCheckPanel getValues={() => values} />
          <DocsNote />
        </Card>
      )}
    </div>
  );
}

function DocsNote() {
  return (
    <div className="mt-5 flex items-start gap-3 rounded-lg bg-blue-50/60 p-4">
      <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-blue-600" />
      <p className="text-xs text-gray-600">
        <span className="font-medium text-gray-900">No documents are uploaded in onboarding.</span>{" "}
        The documents bucket is created by Terraform during deployment; documents are managed
        per-chatbot afterwards.
      </p>
    </div>
  );
}

// ── Step 3 ────────────────────────────────────────────────────────────────

const LLM_PROVIDERS = [
  { value: "openai", detail: "GPT-4o, GPT-4o-mini and more" },
  { value: "anthropic", detail: "Claude Sonnet, Haiku and more" },
  { value: "openrouter", detail: "Access to multiple open source models" },
] as const;

export function StepAiConfig({ values, set, errors }: StepProps) {
  const cloud = (values.cloudProvider ?? "aws") as "aws" | "azure";
  const azure = cloud === "azure";
  const vectorStore = (values.vectorStore ?? "pinecone") as "pinecone" | "pgvector";
  const secretStore = azure ? "Azure Key Vault" : "AWS Secrets Manager";

  return (
    <div className="space-y-6">
      <InfoBanner title="Your data stays in your cloud environment" badge="Secure by design" icon={<ShieldCheck className="h-5 w-5" />}>
        The chatbot runtime can use an external language-model provider and either a tenant-specific
        Pinecone index or a cloud-hosted pgvector database. Your documents remain in your data plane
        and are never read, copied or previewed by our control plane.
      </InfoBanner>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card title="LLM Provider" subtitle="Choose the language model provider for your chatbot runtime." icon={<Brain className="h-5 w-5" />}>
          <div className="grid gap-3 sm:grid-cols-3">
            {LLM_PROVIDERS.map((p) => (
              <ChoiceCard
                key={p.value}
                name="llmProviderChoice"
                checked={values.llmProvider === p.value}
                onSelect={() => set("llmProvider", p.value)}
                logo={<LlmLogo provider={p.value} className="h-5 w-auto" />}
                title={llmProviderLabel(p.value)}
                subtitle={p.detail}
              />
            ))}
          </div>
          {errors.llmProvider && (
            <p className="mt-2 text-xs text-red-600">{errors.llmProvider}</p>
          )}

          <div className="mt-5 space-y-4">
            <Field
              label="Model"
              value={values.llmModel ?? ""}
              onChange={(v) => set("llmModel", v)}
              placeholder="Leave blank for the provider default"
              hint="e.g. gpt-4o-mini · claude-3-5-haiku-20241022 · meta-llama/llama-3.3-70b-instruct:free"
              error={errors.llmModel}
            />
            <Field
              label="API Key"
              required
              type="password"
              value={values.llmApiKey ?? ""}
              onChange={(v) => set("llmApiKey", v)}
              placeholder="sk-..."
              hint={`Written to the customer's ${secretStore} during onboarding.`}
              error={errors.llmApiKey}
              tooltip="OpenAI — platform.openai.com → API keys · Anthropic — console.anthropic.com → API keys · OpenRouter — openrouter.ai → Keys."
            />
          </div>

          <div className="mt-5 flex items-start gap-3 rounded-lg bg-gray-50 p-4">
            <Lock className="mt-0.5 h-4 w-4 shrink-0 text-gray-500" />
            <p className="text-xs text-gray-600">
              <span className="font-medium text-gray-900">API secrets are stored securely.</span> We
              never display your API keys back to you. The key is written into the customer&apos;s
              own {secretStore} and referenced from there at runtime.
            </p>
          </div>
        </Card>

        <Card title="Vector Store" subtitle="Choose where document embeddings will be stored and searched." icon={<Database className="h-5 w-5" />}>
          <div className="grid gap-3 sm:grid-cols-2">
            <ChoiceCard
              name="vectorStoreChoice"
              checked={vectorStore === "pinecone"}
              onSelect={() => set("vectorStore", "pinecone")}
              logo={<VectorStoreLogo store="pinecone" className="h-5 w-auto" />}
              title="Pinecone"
              badge="External service"
            >
              Use a tenant-specific Pinecone index for vector search.
            </ChoiceCard>
            <ChoiceCard
              name="vectorStoreChoice"
              checked={vectorStore === "pgvector"}
              onSelect={() => set("vectorStore", "pgvector")}
              logo={<VectorStoreLogo store="pgvector" className="h-5 w-auto" />}
              title="pgvector"
              badge="Provisioned in client cloud"
            >
              Use a PostgreSQL database with the pgvector extension in your cloud environment.
            </ChoiceCard>
          </div>

          <div className="mt-5 rounded-lg bg-gray-50 p-4 text-xs text-gray-600">
            {vectorStore === "pinecone" ? (
              <>
                <span className="font-medium text-gray-900">Pinecone in the customer&apos;s project.</span>{" "}
                Embeddings live in the customer&apos;s own Pinecone project. Lower cost and nothing to
                operate, but document embeddings leave their cloud account.
              </>
            ) : (
              <>
                <span className="font-medium text-gray-900">pgvector in your cloud.</span> Embeddings
                stay inside the customer&apos;s {azure ? "Azure subscription" : "AWS account"} alongside
                their documents. Stronger data residency; adds a managed database to the monthly bill.
              </>
            )}
          </div>

          {vectorStore === "pinecone" && (
            <div className="mt-4">
              <Field
                label="Pinecone API Key"
                required
                type="password"
                value={values.pineconeApiKey ?? ""}
                onChange={(v) => set("pineconeApiKey", v)}
                placeholder="pcsk_..."
                hint={`The customer's own key. Written to their ${secretStore}.`}
                error={errors.pineconeApiKey}
                tooltip="Created in the customer's own Pinecone account: app.pinecone.io → API keys. The platform provisions one index per tenant."
              />
            </div>
          )}
        </Card>
      </div>

    </div>
  );
}

// ── Step 4 ────────────────────────────────────────────────────────────────

export function StepReview({
  values,
  goToStep,
  formError,
  githubRepo,
}: {
  values: Values;
  goToStep: (n: number) => void;
  githubRepo: GithubRepo | null;
  /**
   * A failure that belongs to the whole submission rather than one field:
   * provisioning into the customer's cloud, or dispatching the deploy.
   * Nothing was created when this is set, so the fix is to correct the
   * offending value and press Deploy again.
   */
  formError?: string;
}) {
  const cloud = (values.cloudProvider ?? "aws") as "aws" | "azure";
  const azure = cloud === "azure";
  const vectorStore = (values.vectorStore ?? "pinecone") as "pinecone" | "pgvector";
  const est = estimateMonthlyCost(cloud, vectorStore);
  const provider = (values.llmProvider ?? "openai") as "openai" | "anthropic" | "openrouter";

  const editButton = (step: number) => (
    <button
      type="button"
      onClick={() => goToStep(step)}
      className="shrink-0 rounded-lg border px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50"
    >
      Edit
    </button>
  );

  return (
    <div className="space-y-6">
      {formError && (
        <div
          role="alert"
          className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800"
        >
          <p className="font-semibold">Deployment could not be started</p>
          <p className="mt-1 leading-relaxed">{formError}</p>
          <p className="mt-2 text-xs text-red-700">
            Nothing was created. Correct the value above and press Deploy again.
          </p>
        </div>
      )}

      <InfoBanner title="Your data stays in your client-owned cloud environment" badge="Secure by design" icon={<ShieldCheck className="h-5 w-5" />}>
        This platform orchestrates the deployment, but the chatbot and all of its resources (compute,
        storage, databases) run inside your client-owned cloud environment. Their documents remain in
        their data plane and are never read, copied or stored by the platform.
      </InfoBanner>

      <div className="grid gap-5 lg:grid-cols-2">
        <div className="space-y-5">
          <Card title="Chatbot Summary" subtitle="Basic information about your chatbot." icon={<FileText className="h-5 w-5" />} action={editButton(2)}>
            <dl className="divide-y">
              <SummaryRow label="Name">{values.name || <Missing />}</SummaryRow>
              <SummaryRow label="Slug">{values.slug || <Missing />}</SummaryRow>
              <SummaryRow label="Version">{values.chatbotVersion || "latest"}</SummaryRow>
              {values.domain && <SummaryRow label="Custom domain">{values.domain}</SummaryRow>}
            </dl>
          </Card>

          <Card title="AI Configuration" subtitle="LLM and vector store settings." icon={<Brain className="h-5 w-5" />} action={editButton(3)}>
            <dl className="divide-y">
              <SummaryRow label="LLM Provider">
                <span className="inline-flex items-center gap-2">
                  <LlmLogo provider={provider} className="h-4 w-auto" />
                  {llmProviderLabel(provider)}
                </span>
              </SummaryRow>
              <SummaryRow label="Model">{values.llmModel || "Provider default"}</SummaryRow>
              <SummaryRow label="Vector Store">
                {vectorStore === "pinecone" ? "Pinecone (customer project)" : "PostgreSQL with pgvector"}
              </SummaryRow>
            </dl>
          </Card>

          <Card title="Estimated Monthly Cost" subtitle="Approximate monthly cost for the deployed chatbot resources." icon={<Boxes className="h-5 w-5" />}>
            <dl className="divide-y">
              {est.lines.map((l) => (
                <SummaryRow key={l.label} label={l.label}>
                  <span className="font-mono text-xs">
                    {l.lowUsd === l.highUsd ? `$${l.highUsd}` : `$${l.lowUsd} – $${l.highUsd}`}
                  </span>
                </SummaryRow>
              ))}
            </dl>
            <div className="mt-3 flex items-baseline justify-between border-t pt-3">
              <span className="text-sm font-semibold text-gray-900">Total (estimated)</span>
              <span className="text-sm font-semibold text-blue-600">
                ${est.totalLow} – ${est.totalHigh} / month
              </span>
            </div>
            <p className="mt-3 text-xs text-gray-500">
              An approximate estimate based on typical resource configurations, not on actual provider
              billing APIs. Actual costs vary with usage, instance types, data volume and the pricing
              in the customer&apos;s own account.{" "}
              {vectorStore === "pinecone"
                ? "Pinecone and LLM API usage are billed separately."
                : "LLM API usage is billed separately; the vector store is included above."}
            </p>
          </Card>
        </div>

        <div className="space-y-5">
          <Card title="Cloud Configuration" subtitle="Your client cloud environment settings." icon={<Cloud className="h-5 w-5" />} action={editButton(2)}>
            <dl className="divide-y">
              <SummaryRow label="Cloud Provider">
                <span className="inline-flex items-center gap-2">
                  <CloudLogo provider={cloud} className="h-4 w-auto" />
                  {CLOUD_LABEL[cloud]}
                </span>
              </SummaryRow>
              {azure ? (
                <>
                  <SummaryRow label="Subscription ID">
                    {values.azureSubscriptionId || <Missing />}
                  </SummaryRow>
                  <SummaryRow label="Azure AD Tenant ID">{values.azureTenantId || <Missing />}</SummaryRow>
                  <SummaryRow label="Region">{values.azureRegion || <Missing />}</SummaryRow>
                  <SummaryRow label="Deployment Identity">
                    {values.azureClientId || <Missing />}
                  </SummaryRow>
                  <SummaryRow label="Federated Subject">
                    <span className="break-all font-mono text-xs">
                      {githubRepo ? azureFederatedSubject(githubRepo, values.tenantId ?? "") : <Missing />}
                    </span>
                    <span className="mt-1 block text-xs text-gray-500">
                      The deployment signs in only if the identity already has a federated credential
                      with this subject. Without one it stops before creating anything.
                    </span>
                  </SummaryRow>
                </>
              ) : (
                <>
                  <SummaryRow label="Account ID">{values.awsAccountId || <Missing />}</SummaryRow>
                  <SummaryRow label="Region">{values.awsRegion || <Missing />}</SummaryRow>
                  <SummaryRow label="IAM Role ARN">
                    <span className="break-all font-mono text-xs">
                      {values.deploymentRoleArn || <Missing />}
                    </span>
                  </SummaryRow>
                  <SummaryRow label="Federated Subject">
                    <span className="break-all font-mono text-xs">
                      {githubRepo ? awsFederatedSubject(githubRepo, values.tenantId ?? "") : <Missing />}
                    </span>
                    <span className="mt-1 block text-xs text-gray-500">
                      The deployment assumes the role only if its trust policy admits this subject.
                      Without it the deployment stops before creating anything.
                    </span>
                  </SummaryRow>
                  <SummaryRow label="External ID">
                    <span className="break-all font-mono text-xs">
                      {awsExternalId(values.tenantId ?? "") || <Missing />}
                    </span>
                    <span className="mt-1 block text-xs text-gray-500">
                      Used once, by the platform itself, to store this chatbot&apos;s API keys in
                      the customer&apos;s Secrets Manager. Without the matching condition on the
                      role, onboarding cannot write them.
                    </span>
                  </SummaryRow>
                  {values.s3DocsPrefix && (
                    <SummaryRow label="S3 Prefix">{values.s3DocsPrefix}</SummaryRow>
                  )}
                  <SummaryRow label="Chat Traffic">
                    {values.acmCertificateArn ? (
                      <>
                        HTTPS on the custom domain, encrypted end to end. Port 80 redirects
                        to it.
                      </>
                    ) : (
                      <>
                        HTTPS via a CloudFront address, since no certificate was supplied.
                        The hop from CloudFront to the load balancer is unencrypted, and the
                        load balancer stays reachable over plain HTTP. Supply a certificate
                        to encrypt the whole path.
                      </>
                    )}
                  </SummaryRow>
                </>
              )}
              <SummaryRow label="Data Plane">
                Documents remain in the client&apos;s {azure ? "Azure subscription" : "AWS account"}.
                The platform only uses the information provided here to orchestrate the deployment.
              </SummaryRow>
            </dl>
          </Card>

          <Card title="Security & Isolation Summary" subtitle="How your data and resources are protected." icon={<Lock className="h-5 w-5" />}>
            <ul className="space-y-4">
              <CheckItem title="Control plane does not store client documents">
                Documents remain in the client cloud environment and are never read, copied or stored
                by the platform.
              </CheckItem>
              <CheckItem title="Only deployment metadata is stored">
                Configuration and deployment status live in the control plane; document contents never
                do.
              </CheckItem>
              <CheckItem title="No stored cloud credentials">
                {azure
                  ? "The platform holds no Azure secret. Each deployment signs in with a short-lived token that the customer's federated credential accepts for this chatbot only."
                  : "The platform holds no AWS key. Each deployment assumes the customer's role for at most an hour, and every call is recorded in their CloudTrail."}
              </CheckItem>
              <CheckItem title="Runtime secrets injected via the client secret store">
                API keys are written into the customer&apos;s own{" "}
                {azure ? "Azure Key Vault" : "AWS Secrets Manager"} and referenced from there.
              </CheckItem>
              <CheckItem title="End-user queries go directly to the deployed chatbot">
                After deployment, queries are routed to the chatbot in the client cloud environment. No
                data is proxied through the platform.
              </CheckItem>
            </ul>
          </Card>
        </div>
      </div>
    </div>
  );
}

function Missing() {
  return <span className="text-red-600">Not set</span>;
}
