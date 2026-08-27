"use client";

import { useActionState, useState } from "react";
import Link from "next/link";
import { createTenantAndDeploy, type FormState } from "./actions";
import { estimateMonthlyCost } from "@/lib/pricing";

const VECTOR_STORE_OPTIONS = [
  {
    value: "pinecone" as const,
    label: "Customer-owned Pinecone",
    detail: () => "Managed service — the customer supplies their own API key",
  },
  {
    value: "pgvector" as const,
    label: "Vector store in the customer's cloud",
    detail: (cloud: "aws" | "azure") =>
      cloud === "azure"
        ? "Azure Database for PostgreSQL + pgvector"
        : "RDS PostgreSQL + pgvector",
  },
];

export default function TenantForm() {
  const [state, formAction, isPending] = useActionState(createTenantAndDeploy, null);
  const [cloud, setCloud] = useState<"aws" | "azure">("aws");
  const [vectorStore, setVectorStore] = useState<"pinecone" | "pgvector">("pinecone");
  const errors = state?.errors ?? {};

  return (
    <form action={formAction} className="mt-8 space-y-5">
      {/* Cloud provider selector */}
      <div>
        <span className="block text-sm font-medium mb-2">Cloud provider</span>
        <div className="flex gap-3">
          {(["aws", "azure"] as const).map((c) => (
            <label
              key={c}
              className={`flex items-center gap-2 rounded-md border px-4 py-2 text-sm cursor-pointer ${
                cloud === c ? "border-black bg-gray-50 font-medium" : "border-gray-200"
              }`}
            >
              <input
                type="radio"
                name="cloudProvider"
                value={c}
                checked={cloud === c}
                onChange={() => setCloud(c)}
                className="sr-only"
              />
              {c === "aws" ? "Amazon Web Services" : "Microsoft Azure"}
            </label>
          ))}
        </div>
      </div>

      <hr className="border-gray-200" />

      {/* Shared fields */}
      <Field
        label="Tenant name"
        name="name"
        placeholder="Acme Corp"
        required
        error={errors.name}
        tooltip="The customer's display name — shown on the platform dashboard only, never used in cloud resource names."
      />
      <Field
        label="Slug"
        name="slug"
        tooltip="You choose this: a short unique ID baked into every cloud resource name (bucket, cluster, vault). Agree it with the customer — it cannot be changed after creation."
        placeholder={cloud === "azure" ? "acme (max 18 chars for Azure)" : "acme"}
        hint={
          cloud === "azure"
            ? "3–18 chars, lowercase letters, numbers, hyphens. Limited by Azure Key Vault naming (created automatically)."
            : "3–32 chars, lowercase letters, numbers, hyphens."
        }
        required
        pattern={cloud === "azure" ? "[a-z0-9][a-z0-9\\-]{1,16}[a-z0-9]" : "[a-z0-9][a-z0-9\\-]{1,30}[a-z0-9]"}
        minLength={3}
        maxLength={cloud === "azure" ? 18 : 32}
        error={errors.slug}
      />
      <Field
        label="Chatbot version"
        name="chatbotVersion"
        placeholder="v0.1.0"
        defaultValue="latest"
        hint="Git tag / image tag of the chatbot release to deploy."
        error={errors.chatbotVersion}
        tooltip="An image tag from the platform's chatbot releases (platform ECR). Use “latest” unless you were told to pin a specific release."
      />
      <Field
        label="Custom domain (optional)"
        name="domain"
        placeholder="chat.acme.com"
        hint="Leave blank to use the auto-assigned URL. No https:// or trailing slash."
        error={errors.domain}
        tooltip="Provided by the customer's DNS admin. After the first deploy they point a CNAME from this hostname to the chatbot URL shown on the tenant page."
      />

      <hr className="border-gray-200" />

      {/* AWS fields */}
      {cloud === "aws" && (
        <section className="space-y-5">
          <h2 className="text-sm font-semibold text-gray-700">AWS configuration</h2>
          <Field
            label="Customer AWS account ID"
            name="awsAccountId"
            placeholder="123456789012"
            required
            pattern="\d{12}"
            minLength={12}
            maxLength={12}
            error={errors.awsAccountId}
            tooltip="The customer finds their 12-digit account ID in the AWS Console account menu (top-right, under their name), or by running: aws sts get-caller-identity"
          />
          <Field
            label="AWS region"
            name="awsRegion"
            placeholder="us-east-1"
            defaultValue="us-east-1"
            required
            pattern="[a-z]{2}-[a-z]+-[0-9]"
            title="Must be a valid AWS region, e.g. us-east-1"
            error={errors.awsRegion}
            tooltip="Pick the region closest to the customer's users. The full list is in the AWS Console region selector (top-right), e.g. us-east-1, eu-central-1."
          />
          <Field
            label="Deployment role ARN"
            name="deploymentRoleArn"
            placeholder="arn:aws:iam::123456789012:role/chatbot-client-deploy-acme"
            hint="Role name must start with chatbot-client-deploy- — the platform's own AWS identity can only assume roles matching that pattern."
            required
            error={errors.deploymentRoleArn}
            tooltip="The customer creates this: AWS Console → IAM → Roles → Create role, trusting the platform's AWS account, then copies the ARN from the role's summary page. Name it chatbot-client-deploy-<something> — the platform's IAM policy only permits assuming roles with that prefix."
          />
          <Field
            label="S3 prefix (optional)"
            name="s3DocsPrefix"
            placeholder="knowledge-base/"
            hint="Restrict the chatbot to documents under this prefix within the auto-created bucket. No leading slash."
            error={errors.s3DocsPrefix}
            tooltip="A folder path inside the docs bucket the platform creates, e.g. docs/. Ask the customer where they plan to upload their knowledge-base files; leave blank to use the bucket root."
          />
        </section>
      )}

      {/* Azure fields */}
      {cloud === "azure" && (
        <section className="space-y-5">
          <h2 className="text-sm font-semibold text-gray-700">Azure configuration</h2>
          <Field
            label="Subscription ID"
            name="azureSubscriptionId"
            placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
            hint="Customer's Azure subscription ID (UUID format)."
            required
            error={errors.azureSubscriptionId}
            tooltip="The customer finds it in Azure Portal → Subscriptions, or by running: az account show --query id"
          />
          <Field
            label="Azure AD tenant ID"
            name="azureTenantId"
            placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
            hint="Azure Active Directory tenant ID for the customer's subscription."
            required
            error={errors.azureTenantId}
            tooltip="Azure Portal → Microsoft Entra ID → Overview → Tenant ID, or: az account show --query tenantId"
          />
          <Field
            label="Service principal client ID"
            name="azureClientId"
            placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
            hint="Application (client) ID of the service principal with Contributor access."
            required
            error={errors.azureClientId}
            tooltip="Azure Portal → App registrations → the customer's deploy app → Application (client) ID on the overview page. The app needs Contributor on the subscription."
          />
          <Field
            label="Service principal client secret"
            name="azureClientSecret"
            type="password"
            placeholder="your-client-secret"
            hint="Encrypted at rest in the platform database."
            required
            error={errors.azureClientSecret}
            tooltip="App registrations → the app → Certificates & secrets → New client secret. The customer must copy the Value column immediately — Azure shows it only once."
          />
          <Field
            label="Azure region"
            name="azureRegion"
            placeholder="eastus"
            defaultValue="eastus"
            hint="Azure region for all resources (e.g. eastus, westeurope)."
            required
            error={errors.azureRegion}
            tooltip="Pick the region closest to the customer's users. List them with: az account list-locations -o table"
          />
        </section>
      )}

      <hr className="border-gray-200" />
      <h2 className="text-sm font-semibold text-gray-700">LLM</h2>

      <SelectField
        label="LLM provider"
        name="llmProvider"
        options={[
          { value: "openai", label: "OpenAI" },
          { value: "anthropic", label: "Anthropic" },
          { value: "openrouter", label: "OpenRouter (free tier available)" },
        ]}
        required
        error={errors.llmProvider}
        tooltip="Whichever vendor issued the API key below — the chatbot calls this provider for answers."
      />
      <Field
        label="LLM API key"
        name="llmApiKey"
        type="password"
        placeholder="sk-..."
        hint={
          cloud === "azure"
            ? "Written to the customer's Azure Key Vault during onboarding."
            : "Written to the customer's AWS Secrets Manager during onboarding."
        }
        required
        minLength={10}
        error={errors.llmApiKey}
        tooltip="Created in the provider's dashboard: OpenAI — platform.openai.com → API keys · Anthropic — console.anthropic.com → API keys · OpenRouter — openrouter.ai → Keys."
      />
      <Field
        label="LLM model (optional)"
        name="llmModel"
        placeholder="e.g. gpt-4o-mini · claude-3-5-haiku-20241022 · meta-llama/llama-3.3-70b-instruct:free"
        hint="Leave blank to use the default model for the selected provider."
        error={errors.llmModel}
        tooltip="A model ID from the selected provider's model documentation. Leave blank to use the platform's default model for that provider."
      />

      <hr className="border-gray-200" />
      <h2 className="text-sm font-semibold text-gray-700">Vector store</h2>

      <div>
        <div className="grid gap-3 sm:grid-cols-2">
          {VECTOR_STORE_OPTIONS.map((o) => (
            <label
              key={o.value}
              className={`cursor-pointer rounded-md border p-3 text-sm ${
                vectorStore === o.value
                  ? "border-black bg-gray-50"
                  : "border-gray-200 hover:border-gray-300"
              }`}
            >
              <input
                type="radio"
                name="vectorStore"
                value={o.value}
                checked={vectorStore === o.value}
                onChange={() => setVectorStore(o.value)}
                className="sr-only"
              />
              <span className="block font-medium">{o.label}</span>
              <span className="mt-1 block text-xs text-gray-500">{o.detail(cloud)}</span>
            </label>
          ))}
        </div>
        <p className="mt-2 text-xs text-gray-500">
          {vectorStore === "pinecone"
            ? "Embeddings live in the customer's own Pinecone project. Lower cost and nothing to operate, but document embeddings leave their cloud account."
            : `Embeddings stay inside the customer's ${
                cloud === "azure" ? "Azure subscription" : "AWS account"
              } alongside their documents. Stronger data residency; adds a managed database to the monthly bill.`}
        </p>
      </div>

      {vectorStore === "pinecone" && (
        <Field
          label="Pinecone API key"
          name="pineconeApiKey"
          type="password"
          placeholder="pcsk_..."
          hint={
            cloud === "azure"
              ? "The customer's own key. Written to their Azure Key Vault during deploy."
              : "The customer's own key. Written to their AWS Secrets Manager during onboarding."
          }
          required
          minLength={10}
          error={errors.pineconeApiKey}
          tooltip="The customer creates this in their own Pinecone account: app.pinecone.io → API keys. The platform provisions one index per tenant inside that project."
        />
      )}

      <CostPreview cloud={cloud} vectorStore={vectorStore} />

      <div className="flex gap-3 pt-2">
        <button
          type="submit"
          disabled={isPending}
          className="rounded-md bg-black px-5 py-2 text-sm font-medium text-white hover:bg-gray-800 disabled:opacity-50"
        >
          {isPending ? "Deploying…" : "Create tenant & deploy"}
        </button>
        <Link href="/" className="rounded-md border px-5 py-2 text-sm font-medium hover:bg-gray-50">
          Cancel
        </Link>
      </div>
    </form>
  );
}

function CostPreview({
  cloud,
  vectorStore,
}: {
  cloud: "aws" | "azure";
  vectorStore: "pinecone" | "pgvector";
}) {
  const est = estimateMonthlyCost(cloud, vectorStore);
  const top = [...est.lines].sort((a, b) => b.highUsd - a.highUsd).slice(0, 3);
  return (
    <div className="rounded-md border border-gray-200 bg-gray-50 p-4">
      <div className="flex items-baseline justify-between text-sm">
        <span className="font-medium">Estimated infrastructure cost</span>
        <span className="font-semibold">
          ~${est.totalLow}–{est.totalHigh}
          <span className="ml-1 text-xs font-normal text-gray-500">/ month</span>
        </span>
      </div>
      <ul className="mt-2 space-y-0.5 text-xs text-gray-600">
        {top.map((l) => (
          <li key={l.label} className="flex justify-between">
            <span>{l.label}</span>
            <span className="font-mono">
              {l.lowUsd === l.highUsd ? `$${l.highUsd}` : `$${l.lowUsd}–${l.highUsd}`}
            </span>
          </li>
        ))}
        <li className="text-gray-400">+ storage, secrets, logs…</li>
      </ul>
      <p className="mt-2 text-xs text-gray-500">
        Billed to the customer&apos;s {cloud === "azure" ? "Azure subscription" : "AWS account"} at{" "}
        {cloud === "azure" ? "East US" : "us-east-1"} list prices (±20% by region).{" "}
        {vectorStore === "pinecone"
          ? "Pinecone and LLM API usage are billed separately."
          : "LLM API usage is billed separately; the vector store is included above."}{" "}
        A full breakdown appears on the tenant page.
      </p>
    </div>
  );
}

function InfoTip({ text }: { text: string }) {
  return (
    <span className="group relative inline-flex">
      <span
        tabIndex={0}
        role="img"
        aria-label={text}
        className="flex h-4 w-4 cursor-help items-center justify-center rounded-full border border-gray-300 text-[10px] font-semibold leading-none text-gray-400 hover:border-gray-400 hover:text-gray-600 focus:outline-none focus:ring-1 focus:ring-gray-400"
      >
        i
      </span>
      <span
        role="tooltip"
        className="pointer-events-none absolute left-1/2 top-6 z-10 w-64 -translate-x-1/2 rounded bg-gray-900 px-2 py-1.5 text-xs font-normal leading-snug text-white opacity-0 shadow-lg transition-opacity duration-100 group-hover:opacity-100 group-focus-within:opacity-100"
      >
        {text}
      </span>
    </span>
  );
}

function Field({
  label, name, placeholder, hint, required, defaultValue,
  pattern, title, type, minLength, maxLength, error, tooltip,
}: {
  label: string; name: string; placeholder?: string; hint?: string;
  required?: boolean; defaultValue?: string; pattern?: string; title?: string;
  type?: string; minLength?: number; maxLength?: number; error?: string;
  tooltip?: string;
}) {
  return (
    <label className="block">
      <span className="flex items-center gap-1 text-sm font-medium">
        {label}
        {tooltip && <InfoTip text={tooltip} />}
      </span>
      <input
        name={name}
        type={type ?? "text"}
        placeholder={placeholder}
        required={required}
        defaultValue={defaultValue}
        pattern={pattern}
        title={title}
        minLength={minLength}
        maxLength={maxLength}
        autoComplete={type === "password" ? "off" : undefined}
        className={`mt-1 block w-full rounded-md border px-3 py-2 text-sm focus:border-black focus:outline-none ${
          error ? "border-red-400" : ""
        }`}
      />
      {error ? (
        <span className="mt-1 block text-xs text-red-600">{error}</span>
      ) : (
        hint && <span className="mt-1 block text-xs text-gray-500">{hint}</span>
      )}
    </label>
  );
}

function SelectField({
  label, name, options, hint, required, error, tooltip,
}: {
  label: string; name: string; options: { value: string; label: string }[];
  hint?: string; required?: boolean; error?: string; tooltip?: string;
}) {
  return (
    <label className="block">
      <span className="flex items-center gap-1 text-sm font-medium">
        {label}
        {tooltip && <InfoTip text={tooltip} />}
      </span>
      <select
        name={name}
        required={required}
        defaultValue=""
        className={`mt-1 block w-full rounded-md border bg-white px-3 py-2 text-sm focus:border-black focus:outline-none ${
          error ? "border-red-400" : ""
        }`}
      >
        <option value="" disabled>Select…</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
      {error ? (
        <span className="mt-1 block text-xs text-red-600">{error}</span>
      ) : (
        hint && <span className="mt-1 block text-xs text-gray-500">{hint}</span>
      )}
    </label>
  );
}
