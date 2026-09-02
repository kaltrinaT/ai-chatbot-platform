import type { tenantDocuments } from "@/db/schema";
import type { DeployedByJoinRow } from "../deployments/utils";
import { formatBytes } from "../documents/utils";

export type DocumentRow = typeof tenantDocuments.$inferSelect;
export type UploadedByJoinRow = { document: DocumentRow; uploadedByName: string | null };

// The real set of events this platform actually records — no page-view
// logging, API keys, or login tracking exist, so those mockup rows (and the
// IP Address column) have no real data behind them and are left out.
export type AuditEventKind =
  | "deploy-started"
  | "deploy-succeeded"
  | "deploy-failed"
  | "destroy-succeeded"
  | "document-uploaded";

export type AuditEvent = {
  id: string;
  at: Date;
  userName: string | null;
  kind: AuditEventKind;
  actionLabel: string;
  resource: string;
  details: string;
};

const ACTION_LABELS: Record<AuditEventKind, string> = {
  "deploy-started": "Deployment Started",
  "deploy-succeeded": "Deployment Succeeded",
  "deploy-failed": "Deployment Failed",
  "destroy-succeeded": "Tenant Destroyed",
  "document-uploaded": "Document Uploaded",
};

export function auditActionLabel(kind: AuditEventKind): string {
  return ACTION_LABELS[kind];
}

// deploys must be newest-first (matches DeploymentsSection's own
// assumption) — ordinals count up from the oldest so "Deployment #N" stays
// stable across pages/filters and lines up with the Deployments tab.
export function buildAuditEvents(deploys: DeployedByJoinRow[], docs: UploadedByJoinRow[]): AuditEvent[] {
  const deployEvents: AuditEvent[] = deploys.map((r, i) => {
    const ordinal = deploys.length - i;
    const isDestroy = r.deployment.kind === "destroy";
    const kind: AuditEventKind =
      r.deployment.status === "succeeded"
        ? isDestroy
          ? "destroy-succeeded"
          : "deploy-succeeded"
        : r.deployment.status === "failed"
          ? "deploy-failed"
          : "deploy-started";
    return {
      id: `deploy-${r.deployment.id}`,
      at: r.deployment.startedAt,
      userName: r.deployedByName,
      kind,
      actionLabel: auditActionLabel(kind),
      resource: `Deployment #${ordinal}`,
      details: `Version v${r.deployment.chatbotVersion}`,
    };
  });

  const docEvents: AuditEvent[] = docs.map((r) => ({
    id: `doc-${r.document.id}`,
    at: r.document.createdAt,
    userName: r.uploadedByName,
    kind: "document-uploaded",
    actionLabel: auditActionLabel("document-uploaded"),
    resource: "Document",
    details: `${r.document.displayName} · ${formatBytes(r.document.sizeBytes)}`,
  }));

  return [...deployEvents, ...docEvents].sort((a, b) => b.at.getTime() - a.at.getTime());
}

export type DateRangeFilter = "7d" | "30d" | "90d" | "all";

export function dateRangeCutoff(range: DateRangeFilter): Date | null {
  const days = range === "7d" ? 7 : range === "30d" ? 30 : range === "90d" ? 90 : null;
  return days ? new Date(Date.now() - days * 24 * 60 * 60 * 1000) : null;
}

export type AuditFilters = {
  kind?: AuditEventKind;
  range?: DateRangeFilter;
};

export function filterAuditEvents(events: AuditEvent[], filters: AuditFilters): AuditEvent[] {
  const cutoff = filters.range ? dateRangeCutoff(filters.range) : null;
  return events.filter((e) => {
    if (filters.kind && e.kind !== filters.kind) return false;
    if (cutoff && e.at < cutoff) return false;
    return true;
  });
}
