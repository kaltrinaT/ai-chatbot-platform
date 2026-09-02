export type BadgeTone = "gray" | "blue" | "green" | "red" | "yellow" | "indigo" | "violet" | "orange";

// Shared tone -> pill background/text class map. Several tables/panels on
// the tenant detail page render their own status pills (with an icon, or
// custom markup `Badge` doesn't support) rather than using `<Badge>`
// directly, but they should still draw from this one map instead of each
// hand-rolling their own copy of the same colors.
export const PILL_TONE_STYLES: Record<BadgeTone, string> = {
  gray: "bg-gray-100 text-gray-700",
  blue: "bg-blue-100 text-blue-700",
  green: "bg-green-100 text-green-700",
  red: "bg-red-100 text-red-700",
  yellow: "bg-yellow-100 text-yellow-800",
  indigo: "bg-indigo-100 text-indigo-700",
  violet: "bg-violet-100 text-violet-700",
  orange: "bg-orange-100 text-orange-800",
};

export function Badge({ label, tone = "gray" }: { label: string; tone?: BadgeTone }) {
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${PILL_TONE_STYLES[tone]}`}>
      {label}
    </span>
  );
}

const STATUS_TONE: Record<string, BadgeTone> = {
  pending: "gray",
  running: "blue",
  succeeded: "green",
  failed: "red",
  cancelled: "yellow",
};

export function StatusBadge({ status }: { status: string }) {
  return <Badge label={status} tone={STATUS_TONE[status] ?? "gray"} />;
}

type DeploymentKind = "deploy" | "destroy";

/**
 * Dashboard's cross-tenant "Recent deployments" list only fetches the last
 * 10 deployments platform-wide (not full per-tenant history), so it can't
 * safely distinguish initial-deploy from redeploy — label generically.
 */
export function DeploymentKindBadge({ kind }: { kind: DeploymentKind }) {
  return kind === "destroy" ? (
    <Badge label="Destroy" tone="orange" />
  ) : (
    <Badge label="Deploy" tone="indigo" />
  );
}

/**
 * Tenant detail page: full deployment history is available, so distinguish
 * the tenant's first "deploy" row (initial provisioning) from later ones.
 */
export function DetailDeploymentKindBadge({
  kind,
  isInitial,
}: {
  kind: DeploymentKind;
  isInitial: boolean;
}) {
  if (kind === "destroy") return <Badge label="Destroy" tone="orange" />;
  return isInitial ? (
    <Badge label="Initial deploy" tone="indigo" />
  ) : (
    <Badge label="Redeploy" tone="violet" />
  );
}
