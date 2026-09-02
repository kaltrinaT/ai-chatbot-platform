import { CheckCircle2, XCircle, Rocket, Trash2, FileUp } from "lucide-react";
import type { ActivityItem } from "../_data/selectors";

export default function ActivityList({ items }: { items: ActivityItem[] }) {
  if (items.length === 0) {
    return <p className="text-sm text-gray-500">No activity yet.</p>;
  }

  return (
    <ul className="space-y-3">
      {items.map((item) => {
        if (item.kind === "deploy") {
          const d = item.row.deployment;
          const isDestroy = d.kind === "destroy";
          const Icon =
            d.status === "succeeded"
              ? isDestroy
                ? Trash2
                : CheckCircle2
              : d.status === "failed"
                ? XCircle
                : Rocket;
          const tone =
            d.status === "succeeded"
              ? isDestroy
                ? "text-gray-500"
                : "text-green-600"
              : d.status === "failed"
                ? "text-red-600"
                : "text-blue-600";
          const verb = isDestroy
            ? d.status === "succeeded"
              ? "Tenant destroyed"
              : "Destroy"
            : d.status === "succeeded"
              ? "Deployment succeeded"
              : d.status === "failed"
                ? "Deployment failed"
                : "Deployment started";
          return (
            <li key={`d-${d.id}`} className="flex items-start gap-2 text-sm">
              <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${tone}`} />
              <div>
                <div className="text-gray-900">
                  {verb} for {item.row.tenantName}
                </div>
                <div className="text-xs text-gray-500">{d.startedAt.toLocaleString()}</div>
              </div>
            </li>
          );
        }
        const doc = item.row.document;
        return (
          <li key={`doc-${doc.id}`} className="flex items-start gap-2 text-sm">
            <FileUp className="mt-0.5 h-4 w-4 shrink-0 text-purple-600" />
            <div>
              <div className="text-gray-900">Document uploaded to {item.row.tenantName}</div>
              <div className="text-xs text-gray-500">
                {doc.displayName} · {doc.createdAt.toLocaleString()}
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
