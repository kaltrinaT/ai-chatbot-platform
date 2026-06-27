"use client";

import { useActionState, useState } from "react";
import Link from "next/link";
import { createTenantAndDeploy, type FormState } from "./actions";

export default function TenantForm() {
  const [state, formAction, isPending] = useActionState(createTenantAndDeploy, null);
  const [cloud, setCloud] = useState<"aws" | "azure">("aws");
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
      <Field label="Tenant name" name="name" placeholder="Acme Corp" required error={errors.name} />
      <Field
        label="Slug"
        name="slug"
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
      />
      <Field
        label="Custom domain (optional)"
        name="domain"
        placeholder="chat.acme.com"
        hint="Leave blank to use the auto-assigned URL. No https:// or trailing slash."
        error={errors.domain}
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
          />
          <Field
            label="Deployment role ARN"
            name="deploymentRoleArn"
            placeholder="arn:aws:iam::123456789012:role/ai-chatbot-platform-deployer"
            hint="IAM role in the customer account the platform will assume to run Terraform."
            required
            error={errors.deploymentRoleArn}
          />
          <Field
            label="S3 prefix (optional)"
            name="s3DocsPrefix"
            placeholder="knowledge-base/"
            hint="Restrict the chatbot to documents under this prefix within the auto-created bucket. No leading slash."
            error={errors.s3DocsPrefix}
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
          />
          <Field
            label="Azure AD tenant ID"
            name="azureTenantId"
            placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
            hint="Azure Active Directory tenant ID for the customer's subscription."
            required
            error={errors.azureTenantId}
          />
          <Field
            label="Service principal client ID"
            name="azureClientId"
            placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
            hint="Application (client) ID of the service principal with Contributor access."
            required
            error={errors.azureClientId}
          />
          <Field
            label="Service principal client secret"
            name="azureClientSecret"
            type="password"
            placeholder="your-client-secret"
            hint="Encrypted at rest in the platform database."
            required
            error={errors.azureClientSecret}
          />
          <Field
            label="Azure region"
            name="azureRegion"
            placeholder="eastus"
            defaultValue="eastus"
            hint="Azure region for all resources (e.g. eastus, westeurope)."
            required
            error={errors.azureRegion}
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
      />
      <Field
        label="LLM model (optional)"
        name="llmModel"
        placeholder="e.g. gpt-4o-mini · claude-3-5-haiku-20241022 · meta-llama/llama-3.3-70b-instruct:free"
        hint="Leave blank to use the default model for the selected provider."
        error={errors.llmModel}
      />

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

function Field({
  label, name, placeholder, hint, required, defaultValue,
  pattern, title, type, minLength, maxLength, error,
}: {
  label: string; name: string; placeholder?: string; hint?: string;
  required?: boolean; defaultValue?: string; pattern?: string; title?: string;
  type?: string; minLength?: number; maxLength?: number; error?: string;
}) {
  return (
    <label className="block">
      <span className="text-sm font-medium">{label}</span>
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
  label, name, options, hint, required, error,
}: {
  label: string; name: string; options: { value: string; label: string }[];
  hint?: string; required?: boolean; error?: string;
}) {
  return (
    <label className="block">
      <span className="text-sm font-medium">{label}</span>
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
