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
}: {
  label: string;
  name: string;
  placeholder?: string;
  hint?: string;
  required?: boolean;
  defaultValue?: string;
  pattern?: string;
}) {
  return (
    <label className="block">
      <span className="text-sm font-medium">{label}</span>
      <input
        name={name}
        placeholder={placeholder}
        required={required}
        defaultValue={defaultValue}
        pattern={pattern}
        className="mt-1 block w-full rounded-md border px-3 py-2 text-sm focus:border-black focus:outline-none"
      />
      {hint && <span className="mt-1 block text-xs text-gray-500">{hint}</span>}
    </label>
  );
}
