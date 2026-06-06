"use client";

import { useActionState } from "react";
import Link from "next/link";
import { createTenantAndDeploy, type FormState } from "./actions";

export default function TenantForm() {
  const [state, formAction, isPending] = useActionState(
    createTenantAndDeploy,
    null
  );
  const errors = state?.errors ?? {};

  return (
    <form action={formAction} className="mt-8 space-y-5">
      <Field
        label="Tenant name"
        name="name"
        placeholder="Acme Corp"
        required
        error={errors.name}
      />
      <Field
        label="Slug"
        name="slug"
        placeholder="acme"
        hint="Lowercase letters, numbers, dashes. Used in resource names."
        required
        pattern="[a-z0-9][a-z0-9\-]{1,30}[a-z0-9]"
        minLength={3}
        maxLength={32}
        error={errors.slug}
      />
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
        hint="The IAM role in the customer account that this platform will assume to run Terraform."
        required
        error={errors.deploymentRoleArn}
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
        hint="Leave blank to use the ALB DNS name. No https:// or trailing slash."
        error={errors.domain}
      />

      <hr className="my-2 border-gray-200" />
      <h2 className="text-sm font-semibold text-gray-700">
        Documents &amp; LLM
      </h2>

      <Field
        label="S3 documents bucket"
        name="s3DocsBucket"
        placeholder="acme-chatbot-docs"
        hint="Bucket in the customer account the chatbot will read documents from."
        required
        minLength={3}
        maxLength={63}
        error={errors.s3DocsBucket}
      />
      <Field
        label="S3 prefix (optional)"
        name="s3DocsPrefix"
        placeholder="knowledge-base/"
        hint="Restrict the chatbot to documents under this prefix. No leading slash."
        error={errors.s3DocsPrefix}
      />
      <SelectField
        label="LLM provider"
        name="llmProvider"
        options={[
          { value: "openai", label: "OpenAI" },
          { value: "anthropic", label: "Anthropic" },
        ]}
        required
        error={errors.llmProvider}
      />
      <Field
        label="LLM API key"
        name="llmApiKey"
        type="password"
        placeholder="sk-..."
        hint="Encrypted at rest, written to the customer's AWS Secrets Manager at deploy."
        required
        minLength={10}
        error={errors.llmApiKey}
      />

      <div className="flex gap-3 pt-2">
        <button
          type="submit"
          disabled={isPending}
          className="rounded-md bg-black px-5 py-2 text-sm font-medium text-white hover:bg-gray-800 disabled:opacity-50"
        >
          {isPending ? "Deploying…" : "Create tenant & deploy"}
        </button>
        <Link
          href="/"
          className="rounded-md border px-5 py-2 text-sm font-medium hover:bg-gray-50"
        >
          Cancel
        </Link>
      </div>
    </form>
  );
}

function Field({
  label,
  name,
  placeholder,
  hint,
  required,
  defaultValue,
  pattern,
  title,
  type,
  minLength,
  maxLength,
  error,
}: {
  label: string;
  name: string;
  placeholder?: string;
  hint?: string;
  required?: boolean;
  defaultValue?: string;
  pattern?: string;
  title?: string;
  type?: string;
  minLength?: number;
  maxLength?: number;
  error?: string;
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
  label,
  name,
  options,
  hint,
  required,
  error,
}: {
  label: string;
  name: string;
  options: { value: string; label: string }[];
  hint?: string;
  required?: boolean;
  error?: string;
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
        <option value="" disabled>
          Select…
        </option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
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
