import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import {
  ExternalLink,
  CheckCircle2,
  XCircle,
  Circle,
  RefreshCw,
  Cloud,
  DollarSign,
  Database,
  Lock,
  Building2,
  Network,
  Globe,
  ShieldAlert,
  type LucideIcon,
} from "lucide-react";
import { auth } from "@/auth";
import { db } from "@/db";
import { tenants, deployments, tenantDocuments, users } from "@/db/schema";
import { and, eq, desc } from "drizzle-orm";
import { estimateMonthlyCost } from "@/lib/pricing";
import RedeployButton from "./RedeployButton";
import DeleteTenantButton from "./DeleteTenantButton";
import CostEstimateCard from "./CostEstimateCard";
import DocumentsSection from "./documents/DocumentsSection";
import DeploymentsSection from "./deployments/DeploymentsSection";
import type { DeployedByJoinRow, DeploymentFilters } from "./deployments/utils";
import AuditLogSection from "./audit/AuditLogSection";
import type { AuditFilters, AuditEventKind, UploadedByJoinRow } from "./audit/utils";
import { StatusBadge, Badge, PILL_TONE_STYLES } from "@/app/Badge";
import DashboardShell from "@/app/(dashboard)/_components/DashboardShell";
import StatTile from "@/app/(dashboard)/_components/StatTile";
import { CloudLogo, LlmLogo, VectorStoreLogo, llmProviderLabel } from "@/app/(dashboard)/_components/ProviderLogo";
import ActivityList from "@/app/(dashboard)/_components/ActivityList";
import { avatarInitials, avatarTone, buildActivity, chatbotStatus } from "@/app/(dashboard)/_data/selectors";
import { TONE_STYLES } from "@/app/(dashboard)/_components/StatTile";
import type { DeployJoinRow, DocJoinRow } from "@/app/(dashboard)/_data/queries";

const TABS = [
  { key: "overview", label: "Overview" },
  { key: "documents", label: "Documents" },
  { key: "deployments", label: "Deployments" },
  { key: "infrastructure", label: "Infrastructure" },
  { key: "audit", label: "Audit Log" },
] as const;
type TabKey = (typeof TABS)[number]["key"];

export default async function TenantDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{
    tab?: string;
    docQuery?: string;
    docStatus?: string;
    docType?: string;
    docPage?: string;
    deployStatus?: string;
    deployRange?: string;
    deployPage?: string;
    deployPageSize?: string;
    selected?: string;
    auditRange?: string;
    auditAction?: string;
    auditPage?: string;
    auditPageSize?: string;
  }>;
}) {
  const session = await auth();
  if (!session?.user?.id) redirect("/signin");

  const { id } = await params;
  const {
    tab: tabParam,
    docQuery,
    docStatus,
    docType,
    docPage: docPageParam,
    deployStatus,
    deployRange,
    deployPage: deployPageParam,
    deployPageSize: deployPageSizeParam,
    selected,
    auditRange,
    auditAction,
    auditPage: auditPageParam,
    auditPageSize: auditPageSizeParam,
  } = await searchParams;
  const tab: TabKey = TABS.some((t) => t.key === tabParam) ? (tabParam as TabKey) : "overview";
  const docFilters = {
    q: docQuery || undefined,
    status: (["uploaded", "pending", "failed"] as const).find((s) => s === docStatus),
    type: docType || undefined,
  };
  const docPage = Math.max(1, Number(docPageParam) || 1);
  const deployFilters: DeploymentFilters = {
    status: (["succeeded", "running", "failed"] as const).find((s) => s === deployStatus),
    range: (["7d", "30d", "90d", "all"] as const).find((r) => r === deployRange),
  };
  const deployPage = Math.max(1, Number(deployPageParam) || 1);
  const deployPageSize = ([10, 20, 50] as const).find((s) => s === Number(deployPageSizeParam)) ?? 10;
  const auditFilters: AuditFilters = {
    kind: (
      [
        "deploy-started",
        "deploy-succeeded",
        "deploy-failed",
        "destroy-succeeded",
        "document-uploaded",
      ] satisfies AuditEventKind[]
    ).find((k) => k === auditAction),
    range: (["7d", "30d", "90d", "all"] as const).find((r) => r === auditRange),
  };
  const auditPage = Math.max(1, Number(auditPageParam) || 1);
  const auditPageSize = ([10, 20, 50] as const).find((s) => s === Number(auditPageSizeParam)) ?? 10;

  const [tenant] = await db
    .select()
    .from(tenants)
    .where(and(eq(tenants.id, id), eq(tenants.ownerUserId, session.user.id)));

  if (!tenant) notFound();

  const tenantDeploysRaw = await db
    .select({ deployment: deployments, deployedByName: users.name })
    .from(deployments)
    .leftJoin(users, eq(deployments.triggeredByUserId, users.id))
    .where(eq(deployments.tenantId, tenant.id))
    .orderBy(desc(deployments.startedAt));
  const tenantDeploys = tenantDeploysRaw.map((r: DeployedByJoinRow) => r.deployment);
  const deployedByRows: DeployedByJoinRow[] = tenantDeploysRaw;

  const documentsRaw = await db
    .select({ document: tenantDocuments, uploadedByName: users.name })
    .from(tenantDocuments)
    .leftJoin(users, eq(tenantDocuments.uploadedByUserId, users.id))
    .where(eq(tenantDocuments.tenantId, tenant.id))
    .orderBy(desc(tenantDocuments.createdAt));
  const documents = documentsRaw.map((r: UploadedByJoinRow) => r.document);
  const uploadedByRows: UploadedByJoinRow[] = documentsRaw;

  const isDeploying = tenantDeploys.some(
    (d: { status: string }) => d.status === "pending" || d.status === "running",
  );

  const latestDeploy = tenantDeploys[0];
  const status = tenant.deletedAt ? { label: "Deleted", tone: "gray" as const } : chatbotStatus(latestDeploy);
  const canOpen = !tenant.deletedAt && status.label === "Online" && Boolean(tenant.chatbotUrl);
  const cost = estimateMonthlyCost(tenant.cloudProvider, tenant.vectorStore);
  const showDocumentsTab = !tenant.deletedAt;
  const visibleTabs = TABS.filter((t) => t.key !== "documents" || showDocumentsTab);

  function tabHref(key: TabKey): string {
    return key === "overview" ? `/tenants/${tenant.id}` : `/tenants/${tenant.id}?tab=${key}`;
  }

  // Reuses the dashboard's activity builder/renderer, scoped to this one
  // tenant instead of a whole owner's fleet.
  const deployJoinRows: DeployJoinRow[] = tenantDeploys.map((d: typeof deployments.$inferSelect) => ({
    deployment: d,
    tenantName: tenant.name,
    tenantSlug: tenant.slug,
  }));
  const docJoinRows: DocJoinRow[] = documents.map((doc: typeof tenantDocuments.$inferSelect) => ({
    document: doc,
    tenantName: tenant.name,
  }));
  const activity = buildActivity(deployJoinRows, docJoinRows).slice(0, 8);

  // Infrastructure panel: names deterministic from this platform's own
  // Terraform (infra/terraform/main.tf, infra/terraform/azure/main.tf), not
  // fetched from AWS/Azure — the platform holds no credential to read back
  // AWS-assigned IDs (e.g. the VPC ID), only what it already wrote to the DB
  // (S3 bucket, ALB DNS) plus these deterministic resource *names*.
  const infra =
    tenant.cloudProvider === "aws"
      ? {
          rows: [
            { label: "VPC", value: `chatbot-${tenant.slug}-vpc` },
            { label: "ECS Cluster", value: `chatbot-${tenant.slug}` },
            { label: "Backend Service", value: `chatbot-${tenant.slug}` },
            { label: "Frontend Service", value: `chatbot-${tenant.slug}-frontend` },
            { label: "Load Balancer", value: tenant.albDnsName ?? `chatbot-${tenant.slug}-alb` },
            { label: "Documents Storage", value: tenant.s3DocsBucket ?? `chatbot-${tenant.slug}-docs` },
          ],
          vectorStoreLabel: tenant.vectorStore === "pgvector" ? "Amazon RDS (pgvector)" : "Pinecone (external)",
          secretsCount: [tenant.llmSecretArn, tenant.pineconeSecretArn, tenant.docsSignerSecretArn].filter(Boolean)
            .length,
        }
      : {
          rows: [
            { label: "Resource Group", value: `chatbot-${tenant.slug}` },
            { label: "Container App Environment", value: `chatbot-${tenant.slug}-env` },
            { label: "Container App", value: `chatbot-${tenant.slug}` },
            { label: "Container Registry", value: `chatbot${tenant.slug}`.replace(/-/g, "").slice(0, 50) },
            { label: "Key Vault", value: `cb-${tenant.slug}-kv` },
            {
              label: "Storage Account",
              value: `chatbot${tenant.slug}`.replace(/-/g, "").slice(0, 24),
            },
          ],
          vectorStoreLabel:
            tenant.vectorStore === "pgvector" ? "Azure Database for PostgreSQL (pgvector)" : "Pinecone (external)",
          secretsCount: [tenant.llmSecretArn].filter(Boolean).length,
        };

  const runtimeLabel = tenant.cloudProvider === "aws" ? "ECS Fargate" : "Azure Container Apps";

  // Same shape as `infra.rows` but with the extra Service/Purpose columns the
  // Infrastructure tab's table shows. Kept separate from `infra.rows` (used
  // by the Overview summary) so that panel's simpler two-column layout is
  // unaffected.
  const infraResources: { resource: string; service: string; purpose: string; identifier: string }[] =
    tenant.cloudProvider === "aws"
      ? [
          {
            resource: "Virtual Private Cloud",
            service: "Amazon VPC",
            purpose: "Network isolation for this tenant's resources",
            identifier: `chatbot-${tenant.slug}-vpc`,
          },
          {
            resource: "Application Load Balancer",
            service: "Elastic Load Balancing",
            purpose: "Routes traffic to the frontend and backend services",
            identifier: tenant.albDnsName ?? `chatbot-${tenant.slug}-alb`,
          },
          {
            resource: "Frontend Service",
            service: "Amazon ECS Fargate",
            purpose: "Hosts the chat user interface",
            identifier: `chatbot-${tenant.slug}-frontend`,
          },
          {
            resource: "Backend Service",
            service: "Amazon ECS Fargate",
            purpose: "Hosts the FastAPI backend and RAG endpoints",
            identifier: `chatbot-${tenant.slug}`,
          },
          {
            resource: "Document Storage",
            service: "Amazon S3",
            purpose: "Stores uploaded knowledge-base documents",
            identifier: tenant.s3DocsBucket ?? `chatbot-${tenant.slug}-docs`,
          },
          {
            resource: "Runtime Secrets",
            service: "AWS Secrets Manager",
            purpose: "Stores the LLM API key and other runtime secrets",
            identifier: tenant.llmSecretArn ?? "(pending)",
          },
          {
            resource: "Log Collection",
            service: "Amazon CloudWatch Logs",
            purpose: "Collects application and deployment logs",
            identifier: `/ecs/chatbot-${tenant.slug}`,
          },
          ...(tenant.vectorStore === "pgvector"
            ? [
                {
                  resource: "Vector Database",
                  service: "Amazon RDS (PostgreSQL + pgvector)",
                  purpose: "Stores document embeddings for retrieval",
                  identifier: `chatbot-${tenant.slug}-vectors`,
                },
              ]
            : []),
        ]
      : [
          {
            resource: "Resource Group",
            service: "Azure Resource Manager",
            purpose: "Logical container for this tenant's Azure resources",
            identifier: `chatbot-${tenant.slug}`,
          },
          {
            resource: "Container App Environment",
            service: "Azure Container Apps",
            purpose: "Hosting environment shared by the frontend and backend apps",
            identifier: `chatbot-${tenant.slug}-env`,
          },
          {
            resource: "Container App",
            service: "Azure Container Apps",
            purpose: "Hosts the chatbot frontend and backend",
            identifier: `chatbot-${tenant.slug}`,
          },
          {
            resource: "Container Registry",
            service: "Azure Container Registry",
            purpose: "Stores the chatbot's container images",
            identifier: `chatbot${tenant.slug}`.replace(/-/g, "").slice(0, 50),
          },
          {
            resource: "Runtime Secrets",
            service: "Azure Key Vault",
            purpose: "Stores the LLM API key and other runtime secrets",
            identifier: `cb-${tenant.slug}-kv`,
          },
          {
            resource: "Document Storage",
            service: "Azure Blob Storage",
            purpose: "Stores uploaded knowledge-base documents",
            identifier: `chatbot${tenant.slug}`.replace(/-/g, "").slice(0, 24),
          },
          ...(tenant.vectorStore === "pgvector"
            ? [
                {
                  resource: "Vector Database",
                  service: "Azure Database for PostgreSQL",
                  purpose: "Stores document embeddings for retrieval",
                  identifier: `${`chatbot-${tenant.slug}-pg`.slice(0, 63)}`,
                },
              ]
            : []),
        ];

  // The platform doesn't poll AWS/Azure for live per-resource health, so
  // every row shares one honest status derived from the tenant's own
  // deployment state instead of inventing per-service telemetry.
  const resourceStatus: { label: string; tone: "green" | "blue" | "red" | "gray" } = tenant.deletedAt
    ? { label: "Torn down", tone: "gray" }
    : !latestDeploy
      ? { label: "Not yet deployed", tone: "gray" }
      : latestDeploy.status === "succeeded"
        ? { label: "Provisioned", tone: "green" }
        : latestDeploy.status === "failed"
          ? { label: "Deploy failed", tone: "red" }
          : { label: "Deploying", tone: "blue" };
  const docsStorageLabel = tenant.cloudProvider === "aws" ? "Amazon S3" : "Azure Blob Storage";
  const secretsLabel = tenant.cloudProvider === "aws" ? "AWS Secrets Manager" : "Azure Key Vault";

  const statusIcon =
    status.label === "Online"
      ? CheckCircle2
      : status.label === "Deploying"
        ? RefreshCw
        : status.label === "Failed"
          ? XCircle
          : Circle;
  const statusTone: "green" | "blue" | "red" | "gray" =
    status.label === "Online" ? "green" : status.label === "Deploying" ? "blue" : status.label === "Failed" ? "red" : "gray";

  return (
    <DashboardShell active="chatbots">
      <div className="mx-auto max-w-7xl px-6 py-8">
        <div className="text-sm text-gray-500">
          <Link href="/chatbots" className="hover:underline">
            All Chatbots
          </Link>
          <span className="mx-1.5">/</span>
          <span className="text-gray-700">{tenant.name}</span>
        </div>

        <div className="mt-4 flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-start gap-4">
            <div
              className={`flex h-16 w-16 shrink-0 items-center justify-center rounded-xl text-xl font-semibold ${TONE_STYLES[avatarTone(tenant.id)]}`}
            >
              {avatarInitials(tenant.name)}
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-3xl font-semibold">{tenant.name}</h1>
                <Badge label={status.label} tone={status.tone} />
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <span className="flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs">
                  <CloudLogo provider={tenant.cloudProvider} />
                  {tenant.cloudProvider === "aws" ? "AWS" : "Azure"}
                </span>
                <span className="rounded-full border px-3 py-1.5 text-xs text-gray-600">
                  {tenant.cloudProvider === "aws" ? (tenant.awsRegion ?? "—") : (tenant.azureRegion ?? "—")}
                </span>
                <span className="flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs">
                  <LlmLogo provider={tenant.llmProvider} />
                  {llmProviderLabel(tenant.llmProvider)}
                </span>
                {tenant.llmModel && (
                  <span className="rounded-full border px-3 py-1.5 text-xs text-gray-600">{tenant.llmModel}</span>
                )}
                <span className="flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs">
                  <VectorStoreLogo store={tenant.vectorStore} />
                  {tenant.vectorStore}
                </span>
              </div>
            </div>
          </div>

          <div className="ml-auto flex flex-col items-end gap-3">
            {!tenant.deletedAt && (
              <div className="flex flex-wrap items-center justify-end gap-2">
                {canOpen && (
                  <a
                    href={tenant.chatbotUrl!}
                    target="_blank"
                    rel="noreferrer"
                    className="flex items-center gap-1.5 rounded-md border px-3 py-2 text-sm font-medium hover:bg-gray-50"
                  >
                    <ExternalLink className="h-4 w-4" />
                    Open Chatbot
                  </a>
                )}
                <RedeployButton tenantId={tenant.id} disabled={isDeploying} />
                <DeleteTenantButton
                  tenantId={tenant.id}
                  slug={tenant.slug}
                  disabled={isDeploying || tenant.cloudProvider !== "aws"}
                  disabledReason={
                    isDeploying
                      ? "A deployment is already in progress"
                      : tenant.cloudProvider !== "aws"
                        ? "Tenant deletion isn't available for Azure tenants yet"
                        : undefined
                  }
                />
              </div>
            )}

            <div className="flex items-center gap-6 text-right text-sm">
              <div>
                <div className="text-xs text-gray-500">Created</div>
                <div className="font-medium">{tenant.createdAt.toLocaleDateString()}</div>
                <div className="text-xs text-gray-500">by {session.user.name ?? session.user.email}</div>
              </div>
              <div>
                <div className="text-xs text-gray-500">Last Deployment</div>
                <div className="font-medium">{latestDeploy ? latestDeploy.startedAt.toLocaleString() : "—"}</div>
                {latestDeploy && <StatusBadge status={latestDeploy.status} />}
              </div>
              <div>
                <div className="text-xs text-gray-500">Est. Monthly Cost</div>
                <div className="font-medium">
                  ${cost.totalLow} – ${cost.totalHigh}
                </div>
              </div>
            </div>
          </div>
        </div>

        {tenant.deletedAt && (
          <div className="mt-6 rounded border border-gray-300 bg-gray-50 p-4 text-sm text-gray-700">
            This tenant was deleted on {tenant.deletedAt.toLocaleString()}. Its infrastructure has been torn
            down; history below is kept for reference.
          </div>
        )}

        <nav className="mt-6 flex gap-6 border-b text-sm">
          {visibleTabs.map((t) => (
            <Link
              key={t.key}
              href={tabHref(t.key)}
              className={`-mb-px border-b-2 px-1 py-3 font-medium ${
                tab === t.key ? "border-blue-600 text-blue-600" : "border-transparent text-gray-500 hover:text-gray-700"
              }`}
            >
              {t.label}
            </Link>
          ))}
        </nav>

        {tab === "overview" && (
          <div className="mt-6 space-y-6">
            <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
              <StatTile
                icon={statusIcon}
                tone={statusTone}
                label="Deployment Status"
                value={status.label}
                sublabel={
                  status.label === "Online" && latestDeploy
                    ? `Since ${latestDeploy.startedAt.toLocaleString()}`
                    : undefined
                }
              />
              <StatTile
                icon={Cloud}
                tone="purple"
                label="Cloud & Region"
                value={tenant.cloudProvider === "aws" ? "AWS" : "Azure"}
                sublabel={tenant.cloudProvider === "aws" ? (tenant.awsRegion ?? "—") : (tenant.azureRegion ?? "—")}
              />
              <StatTile
                icon={Cloud}
                tone="blue"
                label="LLM Provider"
                value={llmProviderLabel(tenant.llmProvider)}
                sublabel={tenant.llmModel ?? undefined}
              />
              <StatTile
                icon={Database}
                tone="orange"
                label="Vector Store"
                value={tenant.vectorStore}
                sublabel={infra.vectorStoreLabel}
              />
              <StatTile
                icon={DollarSign}
                tone="yellow"
                label="Est. Monthly Cost"
                value={`$${cost.totalLow}–$${cost.totalHigh}`}
                sublabel="Based on current usage"
              />
            </div>

            <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
              <div className="rounded-lg border bg-white p-4">
                <h2 className="mb-3 text-sm font-semibold">Deployment Summary</h2>
                <dl className="space-y-2 text-sm">
                  <SummaryRow label="Chatbot URL">
                    {tenant.chatbotUrl ? (
                      <a href={tenant.chatbotUrl} target="_blank" rel="noreferrer" className="text-blue-600 hover:underline">
                        {tenant.chatbotUrl}
                      </a>
                    ) : (
                      "—"
                    )}
                  </SummaryRow>
                  <SummaryRow label="Deployment Status">
                    <StatusBadge status={latestDeploy?.status ?? "pending"} />
                  </SummaryRow>
                  <SummaryRow label="Last Deployment">
                    {latestDeploy ? latestDeploy.startedAt.toLocaleString() : "—"}
                  </SummaryRow>
                  <SummaryRow label="GitHub Workflow">
                    {latestDeploy?.githubRunUrl ? (
                      <a
                        href={latestDeploy.githubRunUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="text-blue-600 hover:underline"
                      >
                        View run ↗
                      </a>
                    ) : (
                      "—"
                    )}
                  </SummaryRow>
                  <SummaryRow label="Environment">Production</SummaryRow>
                  <SummaryRow label="Runtime">{runtimeLabel}</SummaryRow>
                  <SummaryRow label="Documents Storage">{docsStorageLabel}</SummaryRow>
                  <SummaryRow label="Secrets">{secretsLabel}</SummaryRow>
                </dl>
              </div>

              <div className="rounded-lg border bg-white p-4">
                <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold">
                  <Lock className="h-4 w-4 text-green-600" />
                  Security &amp; Isolation
                </h2>
                <dl className="space-y-3 text-sm">
                  <SecurityRow
                    icon={Building2}
                    label="Tenant Isolation"
                    detail={`Dedicated ${tenant.cloudProvider === "aws" ? "AWS account" : "Azure subscription"} — infrastructure never shared with other tenants`}
                    badge="Isolated"
                  />
                  <SecurityRow
                    icon={Network}
                    label="Network Isolation"
                    detail="Dedicated VPC per tenant; the vector database is not publicly accessible and only reachable from this tenant's own tasks"
                    badge="Isolated"
                  />
                  <SecurityRow
                    icon={Database}
                    label="Data Isolation"
                    detail="Tenant-specific storage bucket, database, and secrets — nothing pooled across tenants"
                    badge="Isolated"
                  />
                  <SecurityRow
                    icon={Lock}
                    label="Encryption"
                    detail="Storage encrypted at rest (AES-256); database connections require TLS"
                  />
                </dl>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
              <div className="rounded-lg border bg-white p-4">
                <h2 className="mb-3 text-sm font-semibold">Infrastructure (Provisioned by Platform)</h2>
                <p className="mb-3 text-xs text-gray-500">
                  Resource names follow this platform&apos;s own Terraform naming convention — not read back
                  from {tenant.cloudProvider === "aws" ? "AWS" : "Azure"} directly.
                </p>
                <dl className="space-y-2 text-sm">
                  {infra.rows.map((row) => (
                    <div key={row.label} className="flex items-center justify-between gap-4 border-b py-1.5 last:border-0">
                      <dt className="text-gray-500">{row.label}</dt>
                      <dd className="truncate font-mono text-xs">{row.value}</dd>
                    </div>
                  ))}
                  <div className="flex items-center justify-between gap-4 border-b py-1.5 last:border-0">
                    <dt className="text-gray-500">Vector Store</dt>
                    <dd className="text-xs">{infra.vectorStoreLabel}</dd>
                  </div>
                  <div className="flex items-center justify-between gap-4 border-b py-1.5 last:border-0">
                    <dt className="text-gray-500">Secrets on file</dt>
                    <dd className="text-xs">{infra.secretsCount}</dd>
                  </div>
                </dl>
              </div>

              <div className="rounded-lg border bg-white p-4">
                <h2 className="mb-3 text-sm font-semibold">Recent Activity</h2>
                <ActivityList items={activity} />
              </div>
            </div>

            <CostEstimateCard provider={tenant.cloudProvider} slug={tenant.slug} vectorStore={tenant.vectorStore} />
          </div>
        )}

        {tab === "documents" && showDocumentsTab && (
          <div className="mt-6">
            <DocumentsSection
              tenantId={tenant.id}
              docsSignerUrl={tenant.docsSignerUrl}
              documents={documents}
              filters={docFilters}
              page={docPage}
            />
          </div>
        )}

        {tab === "deployments" && (
          <div className="mt-6">
            <DeploymentsSection
              tenantId={tenant.id}
              region={tenant.cloudProvider === "aws" ? (tenant.awsRegion ?? "—") : (tenant.azureRegion ?? "—")}
              allRows={deployedByRows}
              filters={deployFilters}
              page={deployPage}
              pageSize={deployPageSize}
              selectedId={selected}
            />
          </div>
        )}

        {tab === "infrastructure" && (
          <div className="mt-6 space-y-6">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <StatTile
                icon={Cloud}
                tone="blue"
                label="Cloud Provider"
                value={tenant.cloudProvider === "aws" ? "AWS" : "Azure"}
              />
              <StatTile
                icon={Globe}
                tone="purple"
                label="Region"
                value={tenant.cloudProvider === "aws" ? (tenant.awsRegion ?? "—") : (tenant.azureRegion ?? "—")}
              />
              <StatTile icon={Database} tone="orange" label="Runtime" value={runtimeLabel} />
              <StatTile
                icon={DollarSign}
                tone="yellow"
                label="Estimated Monthly Cost"
                value={`$${cost.totalLow}–$${cost.totalHigh}`}
              />
            </div>

            <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
              <div className="rounded-lg border bg-white p-4 lg:col-span-2">
                <h2 className="mb-3 text-sm font-semibold">Provisioned Resources</h2>
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-sm">
                    <thead>
                      <tr className="border-b text-xs text-gray-500">
                        <th className="py-2 pr-4 font-medium">Resource</th>
                        <th className="py-2 pr-4 font-medium">Service</th>
                        <th className="py-2 pr-4 font-medium">Status</th>
                        <th className="py-2 pr-4 font-medium">Purpose</th>
                        <th className="py-2 font-medium">Identifier</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {infraResources.map((r) => (
                        <tr key={r.resource}>
                          <td className="py-2.5 pr-4 font-medium text-gray-900">{r.resource}</td>
                          <td className="py-2.5 pr-4 text-gray-600">{r.service}</td>
                          <td className="py-2.5 pr-4">
                            <span
                              className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${PILL_TONE_STYLES[resourceStatus.tone]}`}
                            >
                              {resourceStatus.label}
                            </span>
                          </td>
                          <td className="py-2.5 pr-4 text-gray-500">{r.purpose}</td>
                          <td className="max-w-[16rem] truncate py-2.5 font-mono text-xs text-gray-600">
                            {r.identifier}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              <CostEstimateCard provider={tenant.cloudProvider} slug={tenant.slug} vectorStore={tenant.vectorStore} />
            </div>

            <div className="flex items-start gap-3 rounded-lg border bg-blue-50 p-4 text-sm">
              <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-blue-600" />
              <div>
                <div className="font-semibold text-blue-900">Infrastructure Notes</div>
                <p className="mt-1 text-blue-800">
                  This page shows infrastructure provisioned by the platform inside your own{" "}
                  {tenant.cloudProvider === "aws" ? "AWS account" : "Azure subscription"}. Secret values, document
                  contents, and runtime prompts are never exposed here.
                </p>
              </div>
            </div>
          </div>
        )}

        {tab === "audit" && (
          <div className="mt-6 space-y-4">
            <div>
              <h2 className="text-base font-semibold">Audit Log</h2>
              <p className="text-sm text-gray-500">All actions and events related to this chatbot.</p>
            </div>
            <AuditLogSection
              deploys={deployedByRows}
              docs={uploadedByRows}
              filters={auditFilters}
              page={auditPage}
              pageSize={auditPageSize}
            />
          </div>
        )}

      </div>
    </DashboardShell>
  );
}

function SummaryRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b py-1.5 text-sm last:border-0">
      <dt className="text-gray-500">{label}</dt>
      <dd className="truncate text-right">{children}</dd>
    </div>
  );
}

function SecurityRow({
  icon: Icon,
  label,
  detail,
  badge,
}: {
  icon: LucideIcon;
  label: string;
  detail: string;
  badge?: string;
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="flex items-start gap-2">
        <Icon className="mt-0.5 h-4 w-4 shrink-0 text-green-600" />
        <div>
          <div className="font-medium text-gray-900">{label}</div>
          <div className="text-xs text-gray-500">{detail}</div>
        </div>
      </div>
      {badge && (
        <span className="shrink-0 rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-700">
          {badge}
        </span>
      )}
    </div>
  );
}

