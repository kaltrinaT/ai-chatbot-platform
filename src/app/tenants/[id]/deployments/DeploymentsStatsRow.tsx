import { CheckCircle2, RefreshCw, XCircle, ListChecks } from "lucide-react";
import StatTile from "@/app/(dashboard)/_components/StatTile";
import type { DeployedByJoinRow } from "./utils";

export default function DeploymentsStatsRow({ rows }: { rows: DeployedByJoinRow[] }) {
  const total = rows.length;
  const succeeded = rows.filter((r) => r.deployment.status === "succeeded").length;
  const inProgress = rows.filter((r) => ["pending", "running"].includes(r.deployment.status)).length;
  const failed = rows.filter((r) => r.deployment.status === "failed").length;
  const pct = (n: number) => (total > 0 ? Math.round((n / total) * 100) : 0);

  return (
    <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
      <StatTile icon={CheckCircle2} tone="green" label="Succeeded" value={succeeded} sublabel={`${pct(succeeded)}%`} />
      <StatTile icon={RefreshCw} tone="blue" label="In Progress" value={inProgress} sublabel={`${pct(inProgress)}%`} />
      <StatTile icon={XCircle} tone="red" label="Failed" value={failed} sublabel={`${pct(failed)}%`} />
      <StatTile icon={ListChecks} tone="purple" label="Total Deployments" value={total} sublabel="All time" />
    </div>
  );
}
