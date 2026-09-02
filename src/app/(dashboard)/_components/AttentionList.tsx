import Link from "next/link";
import type { AttentionItem } from "../_data/selectors";

export default function AttentionList({ items }: { items: AttentionItem[] }) {
  if (items.length === 0) {
    return <p className="text-sm text-gray-500">Nothing needs your attention.</p>;
  }

  return (
    <ul className="space-y-3">
      {items.map((item) =>
        item.type === "failed-deploy" ? (
          <li key={`fd-${item.deploymentId}`} className="flex items-start justify-between gap-2 text-sm">
            <div>
              <div className="font-medium text-gray-900">Failed deployment</div>
              <div className="text-xs text-gray-500">{item.tenantName}</div>
            </div>
            <Link
              href={`/tenants/${item.tenantId}`}
              className="shrink-0 text-xs text-blue-600 hover:underline"
            >
              View
            </Link>
          </li>
        ) : (
          <li key="docs" className="text-sm">
            <div className="font-medium text-gray-900">
              {item.count} document{item.count === 1 ? "" : "s"} need attention
            </div>
            <div className="text-xs text-gray-500">Pending or failed upload</div>
          </li>
        ),
      )}
    </ul>
  );
}
