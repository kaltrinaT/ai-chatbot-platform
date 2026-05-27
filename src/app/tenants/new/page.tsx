import { redirect } from "next/navigation";
import Link from "next/link";
import { auth } from "@/auth";
import { createTenantAndDeploy } from "./actions";

export default async function NewTenantPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/signin");

  return (
    <main className="mx-auto max-w-2xl px-6 py-10">
      <Link href="/" className="text-sm text-gray-500 hover:underline">
        &larr; Back to dashboard
      </Link>

      <h1 className="mt-4 text-2xl font-semibold">Deploy new tenant</h1>
      <p className="mt-1 text-sm text-gray-500">
        Provisions the chatbot stack into the customer&apos;s AWS account. The
        customer must have already created a deployment role that trusts this
        platform.
      </p>

      <form action={createTenantAndDeploy} className="mt-8 space-y-5">
        <Field label="Tenant name" name="name" placeholder="Acme Corp" required />
        <Field
          label="Slug"
          name="slug"
          placeholder="acme"
          hint="Lowercase letters, numbers, dashes. Used in resource names."
          required
        />
        <Field
          label="Customer AWS account ID"
          name="awsAccountId"
          placeholder="123456789012"
          required
          pattern="\d{12}"
        />
        <Field
          label="AWS region"
          name="awsRegion"
          placeholder="us-east-1"
          defaultValue="us-east-1"
          required
        />
        <Field
          label="Deployment role ARN"
          name="deploymentRoleArn"
          placeholder="arn:aws:iam::123456789012:role/ai-chatbot-platform-deployer"
          hint="The IAM role in the customer account that this platform will assume to run Terraform."
          required
        />
        <Field
          label="Chatbot version"
          name="chatbotVersion"
          placeholder="v0.1.0"
          defaultValue="latest"
          hint="Git tag / image tag of the chatbot release to deploy."
        />
        <Field
          label="Custom domain (optional)"
          name="domain"
          placeholder="chat.acme.com"
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
        />
        <Field
          label="S3 prefix (optional)"
          name="s3DocsPrefix"
          placeholder="knowledge-base/"
          hint="Restrict the chatbot to documents under this prefix."
        />
        <SelectField
          label="LLM provider"
          name="llmProvider"
          options={[
            { value: "openai", label: "OpenAI" },
            { value: "anthropic", label: "Anthropic" },
          ]}
          required
        />
        <Field
          label="LLM API key"
          name="llmApiKey"
          type="password"
          placeholder="sk-..."
          hint="Encrypted at rest, written to the customer's AWS Secrets Manager at deploy."
          required
        />

        <div className="flex gap-3 pt-2">
          <button
            type="submit"
            className="rounded-md bg-black px-5 py-2 text-sm font-medium text-white hover:bg-gray-800"
          >
            Create tenant &amp; deploy
          </button>
          <Link
            href="/"
            className="rounded-md border px-5 py-2 text-sm font-medium hover:bg-gray-50"
          >
            Cancel
          </Link>
        </div>
      </form>
    </main>
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
  type,
}: {
  label: string;
  name: string;
  placeholder?: string;
  hint?: string;
  required?: boolean;
  defaultValue?: string;
  pattern?: string;
  type?: string;
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
        autoComplete={type === "password" ? "off" : undefined}
        className="mt-1 block w-full rounded-md border px-3 py-2 text-sm focus:border-black focus:outline-none"
      />
      {hint && <span className="mt-1 block text-xs text-gray-500">{hint}</span>}
    </label>
  );
}

function SelectField({
  label,
  name,
  options,
  hint,
  required,
}: {
  label: string;
  name: string;
  options: { value: string; label: string }[];
  hint?: string;
  required?: boolean;
}) {
  return (
    <label className="block">
      <span className="text-sm font-medium">{label}</span>
      <select
        name={name}
        required={required}
        defaultValue=""
        className="mt-1 block w-full rounded-md border bg-white px-3 py-2 text-sm focus:border-black focus:outline-none"
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
      {hint && <span className="mt-1 block text-xs text-gray-500">{hint}</span>}
    </label>
  );
}
