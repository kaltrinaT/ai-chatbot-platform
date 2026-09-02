import type { deployments } from "@/db/schema";

export type DeploymentRow = typeof deployments.$inferSelect;
export type DeployedByJoinRow = { deployment: DeploymentRow; deployedByName: string | null };

export function formatDuration(startedAt: Date, endedAt: Date | null): string {
  const ms = (endedAt ?? new Date()).getTime() - startedAt.getTime();
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

export type DeploymentStatusTone = "green" | "blue" | "red" | "yellow" | "gray";

export function deploymentStatusMeta(status: DeploymentRow["status"]): { label: string; tone: DeploymentStatusTone } {
  if (status === "succeeded") return { label: "Succeeded", tone: "green" };
  if (status === "running" || status === "pending") return { label: "In Progress", tone: "blue" };
  if (status === "failed") return { label: "Failed", tone: "red" };
  return { label: "Cancelled", tone: "yellow" };
}

export type DateRangeFilter = "7d" | "30d" | "90d" | "all";

export function dateRangeCutoff(range: DateRangeFilter): Date | null {
  const days = range === "7d" ? 7 : range === "30d" ? 30 : range === "90d" ? 90 : null;
  return days ? new Date(Date.now() - days * 24 * 60 * 60 * 1000) : null;
}

export type DeploymentFilters = {
  status?: "succeeded" | "running" | "failed";
  range?: DateRangeFilter;
};

export function filterDeployments(rows: DeployedByJoinRow[], filters: DeploymentFilters): DeployedByJoinRow[] {
  const cutoff = filters.range ? dateRangeCutoff(filters.range) : null;
  return rows.filter((r) => {
    if (filters.status === "succeeded" && r.deployment.status !== "succeeded") return false;
    if (filters.status === "running" && !["pending", "running"].includes(r.deployment.status)) return false;
    if (filters.status === "failed" && r.deployment.status !== "failed") return false;
    if (cutoff && r.deployment.startedAt < cutoff) return false;
    return true;
  });
}
