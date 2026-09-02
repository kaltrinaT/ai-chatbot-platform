import { FileText, CheckCircle2, RefreshCw, XCircle, Database } from "lucide-react";
import StatTile from "@/app/(dashboard)/_components/StatTile";
import { formatBytes, type DocumentStats } from "./utils";

export default function DocumentsStatsRow({ stats }: { stats: DocumentStats }) {
  const uploadedPct = stats.total > 0 ? Math.round((stats.uploaded / stats.total) * 100) : 0;
  const pendingPct = stats.total > 0 ? Math.round((stats.pending / stats.total) * 100) : 0;
  const failedPct = stats.total > 0 ? Math.round((stats.failed / stats.total) * 100) : 0;

  return (
    <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
      <StatTile icon={FileText} tone="blue" label="Total Documents" value={stats.total} />
      <StatTile icon={CheckCircle2} tone="green" label="Uploaded" value={stats.uploaded} sublabel={`${uploadedPct}%`} />
      <StatTile icon={RefreshCw} tone="purple" label="Pending" value={stats.pending} sublabel={`${pendingPct}%`} />
      <StatTile icon={XCircle} tone="red" label="Failed" value={stats.failed} sublabel={`${failedPct}%`} />
      <StatTile icon={Database} tone="orange" label="Storage" value={formatBytes(stats.storageBytes)} />
    </div>
  );
}
