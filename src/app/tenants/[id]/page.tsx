import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { auth } from "@/auth";
import { db } from "@/db";
import { tenants, deployments } from "@/db/schema";
import { and, eq, desc } from "drizzle-orm";
import RedeployButton from "./RedeployButton";
import DeploymentProgress from "./DeploymentProgress";
import CostEstimateCard from "./CostEstimateCard";

export default async function TenantDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await auth();
  if (!session?.user?.id) redirect("/signin");

  const { id } = await params;

  const [tenant] = await db
    .select()
    .from(tenants)
    .where(and(eq(tenants.id, id), eq(tenants.ownerUserId, session.user.id)));

  if (!tenant) notFound();

  const tenantDeploys = await db
    .select()
    .from(deployments)
    .where(eq(deployments.tenantId, tenant.id))
    .orderBy(desc(deployments.startedAt));

  const isDeploying = tenantDeploys.some(
    (d: { status: string }) => d.status === "pending" || d.status === "running",
  );

  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
      <Link href="/" className="text-sm text-gray-500 hover:underline">
        &larr; Back to dashboard
      </Link>

      <div className="mt-4 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">{tenant.name}</h1>
          <p className="text-sm text-gray-500">{tenant.slug}</p>
        </div>
        <RedeployButton tenantId={tenant.id} disabled={isDeploying} />
      </div>

      {tenant.chatbotUrl ? (
        <a
          href={tenant.chatbotUrl}
          target="_blank"
          rel="noreferrer"
          className="mt-6 block rounded border border-green-200 bg-green-50 p-4 text-sm hover:bg-green-100"
        >
          <div className="text-xs font-medium uppercase tracking-wide text-green-700">
            Chatbot live
          </div>
          <div className="mt-1 font-mono text-green-900">{tenant.chatbotUrl} ↗</div>
        </a>
      ) : (
        <div className="mt-6 rounded border border-dashed p-4 text-sm text-gray-500">
          Chatbot URL will appear here once the first deployment succeeds.
        </div>
      )}

      <dl className="mt-6 grid grid-cols-2 gap-x-6 gap-y-3 rounded border p-4 text-sm">
        <Row
          label="Cloud"
          value={tenant.cloudProvider === "azure" ? "Microsoft Azure" : "Amazon Web Services"}
          hint="The cloud provider this chatbot deploys into. Chosen when the tenant was created and cannot be changed afterward."
        />
        <Row
          label="LLM provider"
          value={tenant.llmProvider}
          hint="The AI model provider powering this chatbot (e.g. Anthropic). Selected at tenant creation; the API key is stored securely in the secret below."
        />
        <Row
          label="Chatbot version"
          value={tenant.chatbotVersion}
          hint="The version tag of the chatbot container image to deploy. Provided by our platform — use the latest unless you were told to pin a specific version."
        />
        <Row
          label="Domain"
          value={tenant.domain ?? "—"}
          hint="Optional custom domain you want the chatbot served on (e.g. chat.yourcompany.com). You own this in your DNS provider and point a CNAME at the URL above. Leave blank to use the default cloud URL."
        />
        <Row
          label="Created"
          value={tenant.createdAt.toISOString()}
          hint="When this tenant was created. Set automatically by the platform — nothing to provide."
        />

        {tenant.cloudProvider === "aws" ? (
          <>
            <Row
              label="AWS account"
              value={tenant.awsAccountId ?? "—"}
              hint="Your 12-digit AWS Account ID. Find it in the AWS Console (top-right, under your account name) or run `aws sts get-caller-identity`."
            />
            <Row
              label="Region"
              value={tenant.awsRegion ?? "—"}
              hint="The AWS region to deploy into, e.g. us-east-1. Pick the region closest to your users. See AWS Console → region selector (top-right)."
            />
            <Row
              label="Deployment role"
              value={tenant.deploymentRoleArn ?? "—"}
              mono
              hint="ARN of the cross-account IAM role our platform assumes to deploy into your account. Create it in AWS Console → IAM → Roles, trust our platform account, then paste the role ARN (arn:aws:iam::<account>:role/...)."
            />
            <Row
              label="S3 docs bucket"
              value={tenant.s3DocsBucket ?? "—"}
              hint="Name of the S3 bucket holding your knowledge-base documents. Create or find it in AWS Console → S3 → Buckets."
            />
            <Row
              label="S3 prefix"
              value={tenant.s3DocsPrefix ?? "—"}
              hint="Folder path inside the bucket where your documents live, e.g. docs/. Leave blank to use the bucket root."
            />
            <Row
              label="LLM secret ARN"
              value={tenant.llmSecretArn ?? "(pending)"}
              mono
              hint="AWS Secrets Manager ARN storing your LLM API key. Created automatically by the platform after the first deployment — you don't provide this."
            />
            <Row
              label="ALB DNS"
              value={tenant.albDnsName ?? "—"}
              mono
              hint="Public DNS name of the load balancer fronting your chatbot. Assigned automatically by AWS after deployment — point your custom domain's CNAME here."
            />
          </>
        ) : (
          <>
            <Row
              label="Subscription ID"
              value={tenant.azureSubscriptionId ?? "—"}
              mono
              hint="Your Azure Subscription ID. Find it in Azure Portal → Subscriptions, or run `az account show --query id`."
            />
            <Row
              label="Azure region"
              value={tenant.azureRegion ?? "—"}
              hint="The Azure location to deploy into, e.g. eastus. Pick the region closest to your users. See Azure Portal → region list."
            />
            <Row
              label="Resource group"
              value={tenant.azureResourceGroup ?? "—"}
              hint="The Azure resource group to deploy resources into. Create or find it in Azure Portal → Resource groups."
            />
            <Row
              label="Key Vault"
              value={tenant.azureKeyVaultName ?? "—"}
              hint="Name of the Azure Key Vault that stores your secrets. Find or create it in Azure Portal → Key vaults."
            />
            <Row
              label="Storage account"
              value={tenant.azureStorageAccount ?? "—"}
              hint="Azure Storage account holding your knowledge-base documents. Azure Portal → Storage accounts."
            />
            <Row
              label="Storage container"
              value={tenant.azureStorageContainer ?? "—"}
              hint="The blob container inside the storage account where your documents are uploaded. Azure Portal → Storage account → Containers."
            />
            <Row
              label="LLM secret URI"
              value={tenant.llmSecretArn ?? "(pending)"}
              mono
              hint="Azure Key Vault secret URI storing your LLM API key. Created automatically by the platform after the first deployment — you don't provide this."
            />
            <Row
              label="Container App FQDN"
              value={tenant.albDnsName ?? "—"}
              mono
              hint="Public URL of your Azure Container App. Assigned automatically after deployment — point your custom domain's CNAME here."
            />
          </>
        )}
      </dl>

      <CostEstimateCard provider={tenant.cloudProvider} slug={tenant.slug} />

      <h2 className="mt-8 mb-3 text-lg font-medium">Deployments</h2>
      {tenantDeploys.length === 0 ? (
        <p className="text-sm text-gray-500">No deployments yet.</p>
      ) : (
        <ul className="divide-y rounded border">
          {tenantDeploys.map((d: typeof deployments.$inferSelect) => (
            <li key={d.id} className="p-4 text-sm">
              <div className="flex items-center justify-between">
                <span className="font-mono text-xs text-gray-500">{d.id}</span>
                <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs">
                  {d.status}
                </span>
              </div>
              <div className="mt-1 text-xs text-gray-500">
                v{d.chatbotVersion} · started {d.startedAt.toISOString()}
                {d.finishedAt && ` · finished ${d.finishedAt.toISOString()}`}
              </div>
              {(d.status === "pending" || d.status === "running") && (
                <DeploymentProgress
                  deploymentId={d.id}
                  startedAt={d.startedAt.toISOString()}
                  initialRunUrl={d.githubRunUrl}
                />
              )}
              {d.errorMessage && (
                <div className="mt-2 rounded bg-red-50 p-2 text-xs text-red-700">
                  {d.errorMessage}
                </div>
              )}
              {d.githubRunUrl && (
                <a
                  href={d.githubRunUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-2 inline-block text-xs text-blue-600 hover:underline"
                >
                  View GitHub Actions run &rarr;
                </a>
              )}
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}

function Row({
  label,
  value,
  mono,
  hint,
}: {
  label: string;
  value: string;
  mono?: boolean;
  hint?: string;
}) {
  return (
    <>
      <dt className="flex items-center gap-1 text-gray-500">
        {label}
        {hint && (
          <span className="group relative inline-flex">
            <span
              tabIndex={0}
              role="img"
              aria-label={hint}
              className="flex h-4 w-4 cursor-help items-center justify-center rounded-full border border-gray-300 text-[10px] font-semibold leading-none text-gray-400 hover:border-gray-400 hover:text-gray-600 focus:outline-none focus:ring-1 focus:ring-gray-400"
            >
              i
            </span>
            <span
              role="tooltip"
              className="pointer-events-none absolute left-1/2 top-6 z-10 w-56 -translate-x-1/2 rounded bg-gray-900 px-2 py-1.5 text-xs font-normal leading-snug text-white opacity-0 shadow-lg transition-opacity duration-100 group-hover:opacity-100 group-focus-within:opacity-100"
            >
              {hint}
            </span>
          </span>
        )}
      </dt>
      <dd className={mono ? "font-mono text-xs break-all" : ""}>{value}</dd>
    </>
  );
}
