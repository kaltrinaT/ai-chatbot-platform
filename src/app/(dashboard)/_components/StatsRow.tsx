import { Bot, Rocket, Cloud, FileText, DollarSign } from "lucide-react";
import StatTile from "./StatTile";
import type { DashboardStats } from "../_data/selectors";

export default function StatsRow({ stats }: { stats: DashboardStats }) {
  return (
    <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-5">
      <StatTile
        icon={Bot}
        tone="blue"
        label="Total Chatbots"
        value={stats.totalChatbots}
        sublabel={`${stats.onlineCount} online`}
      />
      <StatTile
        icon={Rocket}
        tone="green"
        label="Online"
        value={stats.onlineCount}
        sublabel={`${stats.deployingCount} deploying`}
      />
      <StatTile
        icon={Cloud}
        tone="purple"
        label="Cloud Providers"
        value={`${stats.awsCount} AWS · ${stats.azureCount} Azure`}
        sublabel={stats.awsCount > 0 && stats.azureCount > 0 ? "Multi-cloud" : undefined}
      />
      <StatTile
        icon={FileText}
        tone="orange"
        label="Documents"
        value={stats.totalDocs}
        sublabel={`${stats.uploadedDocs} uploaded · ${stats.pendingOrFailedDocsCount} pending`}
      />
      <StatTile
        icon={DollarSign}
        tone="yellow"
        label="Est. Monthly Cost"
        value={`$${stats.costLow}–$${stats.costHigh}`}
        sublabel={`Across ${stats.totalChatbots} chatbots`}
      />
    </div>
  );
}
