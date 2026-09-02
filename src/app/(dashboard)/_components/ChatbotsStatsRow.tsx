import { Bot, CheckCircle2, RefreshCw, XCircle, FileText } from "lucide-react";
import StatTile from "./StatTile";
import type { ChatbotsPageStats } from "../_data/selectors";

export default function ChatbotsStatsRow({ stats }: { stats: ChatbotsPageStats }) {
  return (
    <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-5">
      <StatTile
        icon={Bot}
        tone="blue"
        label="Total Chatbots"
        value={stats.total}
        sublabel={`Across ${stats.cloudsInUse} cloud${stats.cloudsInUse === 1 ? "" : "s"}`}
      />
      <StatTile
        icon={CheckCircle2}
        tone="green"
        label="Online"
        value={stats.online}
        sublabel={`${stats.onlinePct}% of total`}
      />
      <StatTile icon={RefreshCw} tone="purple" label="Deploying" value={stats.deploying} sublabel="In progress" />
      <StatTile
        icon={XCircle}
        tone="red"
        label="Failed"
        value={stats.failed}
        sublabel={stats.failed === 0 ? "All healthy" : `${stats.failed} need attention`}
      />
      <StatTile
        icon={FileText}
        tone="orange"
        label="Total Documents"
        value={stats.totalDocs}
        sublabel={`${stats.uploadedDocs} uploaded · ${stats.pendingOrFailedDocs} pending`}
      />
    </div>
  );
}
