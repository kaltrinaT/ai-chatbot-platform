import { estimateMonthlyCost } from "@/lib/pricing";
import type { BadgeTone } from "../../Badge";
import type { DeployJoinRow, DeploymentRow, DocJoinRow, TenantRow } from "./queries";

// Pure transforms over already-fetched rows — no `db` import here, so none
// of this needs mocking to test.

export function latestDeployByTenant(rows: DeployJoinRow[]): Map<string, DeployJoinRow> {
  const map = new Map<string, DeployJoinRow>();
  for (const row of rows) {
    if (!map.has(row.deployment.tenantId)) map.set(row.deployment.tenantId, row);
  }
  return map;
}

export function hasCloudAccount(t: TenantRow): boolean {
  return t.cloudProvider === "aws"
    ? Boolean(t.deploymentRoleArn && t.awsAccountId)
    : Boolean(t.azureSubscriptionId && t.azureTenantId);
}

export function chatbotStatus(latest: DeploymentRow | undefined): { label: string; tone: BadgeTone } {
  if (!latest) return { label: "Never deployed", tone: "gray" };
  if (latest.status === "succeeded") return { label: "Online", tone: "green" };
  if (latest.status === "pending" || latest.status === "running")
    return { label: "Deploying", tone: "blue" };
  if (latest.status === "failed") return { label: "Failed", tone: "red" };
  return { label: latest.status, tone: "gray" };
}

export type AttentionItem =
  | { type: "failed-deploy"; at: Date; tenantId: string; tenantName: string; deploymentId: string }
  | { type: "docs"; at: Date; count: number };

export function buildAttentionItems(
  latestByTenant: Map<string, DeployJoinRow>,
  docs: DocJoinRow[],
): AttentionItem[] {
  const failedDeploys: AttentionItem[] = [...latestByTenant.values()]
    .filter((r) => r.deployment.status === "failed")
    .map((r) => ({
      type: "failed-deploy",
      at: r.deployment.startedAt,
      tenantId: r.deployment.tenantId,
      tenantName: r.tenantName,
      deploymentId: r.deployment.id,
    }));

  const pendingOrFailedDocs = docs.filter((d) => d.document.status !== "uploaded");
  const docsItem: AttentionItem[] =
    pendingOrFailedDocs.length > 0
      ? [
          {
            type: "docs",
            at: pendingOrFailedDocs.reduce(
              (latest, d) => (d.document.createdAt > latest ? d.document.createdAt : latest),
              pendingOrFailedDocs[0].document.createdAt,
            ),
            count: pendingOrFailedDocs.length,
          },
        ]
      : [];

  return [...failedDeploys, ...docsItem].sort((a, b) => b.at.getTime() - a.at.getTime());
}

export type ActivityItem =
  | { kind: "deploy"; at: Date; row: DeployJoinRow }
  | { kind: "document"; at: Date; row: DocJoinRow };

export function buildActivity(deploys: DeployJoinRow[], docs: DocJoinRow[]): ActivityItem[] {
  return [
    ...deploys.map((row): ActivityItem => ({ kind: "deploy", at: row.deployment.startedAt, row })),
    ...docs.map((row): ActivityItem => ({ kind: "document", at: row.document.createdAt, row })),
  ].sort((a, b) => b.at.getTime() - a.at.getTime());
}

export function computeDocStats(
  docs: DocJoinRow[],
): { total: number; uploaded: number; pendingOrFailed: number } {
  const uploaded = docs.filter((d) => d.document.status === "uploaded").length;
  return { total: docs.length, uploaded, pendingOrFailed: docs.length - uploaded };
}

function countByStatus(
  tenants: TenantRow[],
  latestByTenant: Map<string, DeployJoinRow>,
): { online: number; deploying: number; failed: number } {
  let online = 0;
  let deploying = 0;
  let failed = 0;
  for (const t of tenants) {
    const status = latestByTenant.get(t.id)?.deployment.status;
    if (status === "succeeded") online++;
    else if (status === "pending" || status === "running") deploying++;
    else if (status === "failed") failed++;
  }
  return { online, deploying, failed };
}

export type DashboardStats = {
  totalChatbots: number;
  onlineCount: number;
  deployingCount: number;
  awsCount: number;
  azureCount: number;
  totalDocs: number;
  uploadedDocs: number;
  pendingOrFailedDocsCount: number;
  costLow: number;
  costHigh: number;
};

export function computeDashboardStats(
  activeTenants: TenantRow[],
  latestByTenant: Map<string, DeployJoinRow>,
  allDocs: DocJoinRow[],
): DashboardStats {
  const { online, deploying } = countByStatus(activeTenants, latestByTenant);
  const docStats = computeDocStats(allDocs);
  const costTotals = activeTenants.reduce(
    (acc, t) => {
      const est = estimateMonthlyCost(t.cloudProvider, t.vectorStore);
      return { low: acc.low + est.totalLow, high: acc.high + est.totalHigh };
    },
    { low: 0, high: 0 },
  );

  return {
    totalChatbots: activeTenants.length,
    onlineCount: online,
    deployingCount: deploying,
    awsCount: activeTenants.filter((t) => t.cloudProvider === "aws").length,
    azureCount: activeTenants.filter((t) => t.cloudProvider === "azure").length,
    totalDocs: docStats.total,
    uploadedDocs: docStats.uploaded,
    pendingOrFailedDocsCount: docStats.pendingOrFailed,
    costLow: costTotals.low,
    costHigh: costTotals.high,
  };
}

export type ChatbotsPageStats = {
  total: number;
  cloudsInUse: number;
  online: number;
  onlinePct: number;
  deploying: number;
  failed: number;
  totalDocs: number;
  uploadedDocs: number;
  pendingOrFailedDocs: number;
};

export function computeChatbotsPageStats(
  activeTenants: TenantRow[],
  latestByTenant: Map<string, DeployJoinRow>,
  allDocs: DocJoinRow[],
): ChatbotsPageStats {
  const { online, deploying, failed } = countByStatus(activeTenants, latestByTenant);
  const docStats = computeDocStats(allDocs);
  const total = activeTenants.length;

  return {
    total,
    cloudsInUse: new Set(activeTenants.map((t) => t.cloudProvider)).size,
    online,
    onlinePct: total > 0 ? Math.round((online / total) * 100) : 0,
    deploying,
    failed,
    totalDocs: docStats.total,
    uploadedDocs: docStats.uploaded,
    pendingOrFailedDocs: docStats.pendingOrFailed,
  };
}

export type ChatbotStatusFilter = "all" | "online" | "deploying" | "failed" | "never-deployed";
export type ChatbotSort = "last-deployment" | "name";

const STATUS_FILTER_LABEL: Record<Exclude<ChatbotStatusFilter, "all">, string> = {
  online: "Online",
  deploying: "Deploying",
  failed: "Failed",
  "never-deployed": "Never deployed",
};

export function filterAndSortTenants(
  tenants: TenantRow[],
  latestByTenant: Map<string, DeployJoinRow>,
  { status, sort }: { status: ChatbotStatusFilter; sort: ChatbotSort },
): TenantRow[] {
  const filtered =
    status === "all"
      ? tenants
      : tenants.filter(
          (t) => chatbotStatus(latestByTenant.get(t.id)?.deployment).label === STATUS_FILTER_LABEL[status],
        );

  const sorted = [...filtered];
  if (sort === "name") {
    sorted.sort((a, b) => a.name.localeCompare(b.name));
  } else {
    sorted.sort((a, b) => {
      const aAt = latestByTenant.get(a.id)?.deployment.startedAt ?? a.createdAt;
      const bAt = latestByTenant.get(b.id)?.deployment.startedAt ?? b.createdAt;
      return bAt.getTime() - aAt.getTime();
    });
  }
  return sorted;
}

const AVATAR_TONES = ["blue", "green", "purple", "orange", "yellow"] as const;

// Purely decorative — deterministic per tenant (not random) so the same
// chatbot always gets the same avatar across renders/pages.
export function avatarInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  return name.trim().slice(0, 2).toUpperCase();
}

export function avatarTone(tenantId: string): (typeof AVATAR_TONES)[number] {
  let hash = 0;
  for (let i = 0; i < tenantId.length; i++) hash = (hash * 31 + tenantId.charCodeAt(i)) | 0;
  return AVATAR_TONES[Math.abs(hash) % AVATAR_TONES.length];
}

export type GettingStartedStep = {
  label: string;
  description: string;
  done: boolean;
  href?: string;
};

export function computeGettingStartedSteps(
  activeTenants: TenantRow[],
  allDeploys: DeployJoinRow[],
  allDocs: DocJoinRow[],
): GettingStartedStep[] {
  // "Test Chatbot" isn't an event this app tracks — nothing records that a
  // human opened and tried a chatbot — so instead of a fake completion flag,
  // it's backed by whether there's actually a live URL to test, and doubles
  // as a link to it when there is.
  const liveChatbotUrl = activeTenants.find((t) => t.chatbotUrl)?.chatbotUrl ?? undefined;

  return [
    {
      label: "Configure Cloud",
      description: "Connect your AWS or Azure account",
      done: activeTenants.some(hasCloudAccount),
    },
    {
      label: "Create Chatbot",
      description: "Set up your chatbot configuration",
      done: activeTenants.length > 0,
    },
    {
      label: "Deploy",
      description: "Deploy infrastructure automatically",
      done: allDeploys.some(
        (r) => r.deployment.kind === "deploy" && r.deployment.status === "succeeded",
      ),
    },
    {
      label: "Upload Documents",
      description: "Add documents to your chatbot",
      done: allDocs.length > 0,
    },
    {
      label: "Test Chatbot",
      description: "Open and test your deployed chatbot",
      done: Boolean(liveChatbotUrl),
      href: liveChatbotUrl,
    },
  ];
}
