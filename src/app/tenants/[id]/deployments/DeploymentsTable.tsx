import Link from "next/link";
import { ExternalLink, CheckCircle2, RefreshCw, XCircle, Circle } from "lucide-react";
import { avatarInitials, avatarTone } from "@/app/(dashboard)/_data/selectors";
import { TONE_STYLES } from "@/app/(dashboard)/_components/StatTile";
import { PILL_TONE_STYLES } from "@/app/Badge";
import { deploymentStatusMeta, formatDuration, type DeployedByJoinRow } from "./utils";

const STATUS_ICONS = { green: CheckCircle2, blue: RefreshCw, red: XCircle, yellow: Circle, gray: Circle } as const;

export type NumberedDeployment = DeployedByJoinRow & { ordinal: number };

export default function DeploymentsTable({
  rows,
  region,
  detailHref,
  selectedId,
}: {
  rows: NumberedDeployment[];
  region: string;
  detailHref: (deploymentId: string) => string;
  selectedId?: string;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b text-xs text-gray-500">
            <th className="px-4 py-2 font-medium">Deployment</th>
            <th className="px-4 py-2 font-medium">Status</th>
            <th className="px-4 py-2 font-medium">Environment</th>
            <th className="px-4 py-2 font-medium">Started At</th>
            <th className="px-4 py-2 font-medium">Duration</th>
            <th className="px-4 py-2 font-medium">Deployed By</th>
            <th className="px-4 py-2 font-medium">Version</th>
            <th className="px-4 py-2 font-medium">Actions</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {rows.map(({ deployment: d, deployedByName, ordinal }) => {
            const status = deploymentStatusMeta(d.status);
            const Icon = STATUS_ICONS[status.tone];
            const isActive = d.status === "pending" || d.status === "running";
            return (
              <tr key={d.id} className={selectedId === d.id ? "bg-blue-50/50" : undefined}>
                <td className="px-4 py-3">
                  <div className="font-medium">#{ordinal}</div>
                  <div className="font-mono text-xs text-gray-400">{d.id.slice(0, 8)}</div>
                </td>
                <td className="px-4 py-3">
                  <span
                    className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs ${PILL_TONE_STYLES[status.tone]}`}
                  >
                    <Icon className={`h-3 w-3 ${isActive ? "animate-spin" : ""}`} />
                    {status.label}
                  </span>
                </td>
                <td className="px-4 py-3 text-xs text-gray-600">
                  <span className="mr-1.5 inline-block h-1.5 w-1.5 rounded-full bg-green-500" />
                  Production
                  <div className="text-gray-400">{region}</div>
                </td>
                <td className="px-4 py-3 text-xs text-gray-500">{d.startedAt.toLocaleString()}</td>
                <td className="px-4 py-3 text-xs text-gray-600">
                  {formatDuration(d.startedAt, d.finishedAt)}
                  {isActive && <span className="ml-1 text-gray-400">(running)</span>}
                </td>
                <td className="px-4 py-3">
                  <div className="flex items-center gap-2">
                    <div
                      className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold ${TONE_STYLES[avatarTone(d.triggeredByUserId)]}`}
                    >
                      {deployedByName ? avatarInitials(deployedByName) : "?"}
                    </div>
                    <span className="text-xs text-gray-700">{deployedByName ?? "Unknown"}</span>
                  </div>
                </td>
                <td className="px-4 py-3 text-xs text-gray-600">v{d.chatbotVersion}</td>
                <td className="px-4 py-3">
                  <div className="flex items-center gap-2">
                    <Link
                      href={detailHref(d.id)}
                      className="rounded-md border px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50"
                    >
                      View Details
                    </Link>
                    {d.githubRunUrl && (
                      <a
                        href={d.githubRunUrl}
                        target="_blank"
                        rel="noreferrer"
                        aria-label="View GitHub Actions run"
                        className="flex h-7 w-7 items-center justify-center rounded-md border text-gray-500 hover:bg-gray-50"
                      >
                        <ExternalLink className="h-3.5 w-3.5" />
                      </a>
                    )}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
