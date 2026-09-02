import { CheckCircle2, XCircle, Rocket, Trash2, FileUp } from "lucide-react";
import { avatarInitials, avatarTone } from "@/app/(dashboard)/_data/selectors";
import { TONE_STYLES } from "@/app/(dashboard)/_components/StatTile";
import type { AuditEvent, AuditEventKind } from "./utils";

const ACTION_ICONS: Record<AuditEventKind, typeof CheckCircle2> = {
  "deploy-started": Rocket,
  "deploy-succeeded": CheckCircle2,
  "deploy-failed": XCircle,
  "destroy-succeeded": Trash2,
  "document-uploaded": FileUp,
};

const ACTION_TONES: Record<AuditEventKind, string> = {
  "deploy-started": "text-blue-600",
  "deploy-succeeded": "text-green-600",
  "deploy-failed": "text-red-600",
  "destroy-succeeded": "text-gray-500",
  "document-uploaded": "text-purple-600",
};

export default function AuditLogTable({ events }: { events: AuditEvent[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b text-xs text-gray-500">
            <th className="px-4 py-2 font-medium">Time</th>
            <th className="px-4 py-2 font-medium">User</th>
            <th className="px-4 py-2 font-medium">Action</th>
            <th className="px-4 py-2 font-medium">Resource</th>
            <th className="px-4 py-2 font-medium">Details</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {events.map((e) => {
            const Icon = ACTION_ICONS[e.kind];
            return (
              <tr key={e.id}>
                <td className="px-4 py-3 text-xs text-gray-500">{e.at.toLocaleString()}</td>
                <td className="px-4 py-3">
                  <div className="flex items-center gap-2">
                    <div
                      className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold ${TONE_STYLES[avatarTone(e.userName ?? e.id)]}`}
                    >
                      {e.userName ? avatarInitials(e.userName) : "?"}
                    </div>
                    <span className="text-xs text-gray-700">{e.userName ?? "Unknown"}</span>
                  </div>
                </td>
                <td className="px-4 py-3">
                  <span className="inline-flex items-center gap-1.5 text-xs font-medium text-gray-800">
                    <Icon className={`h-3.5 w-3.5 shrink-0 ${ACTION_TONES[e.kind]}`} />
                    {e.actionLabel}
                  </span>
                </td>
                <td className="px-4 py-3 text-xs text-gray-600">{e.resource}</td>
                <td className="px-4 py-3 text-xs text-gray-500">{e.details}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
