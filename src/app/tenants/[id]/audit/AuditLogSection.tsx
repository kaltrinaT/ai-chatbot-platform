import AuditLogFilterBar from "./AuditLogFilterBar";
import AuditLogTable from "./AuditLogTable";
import Pagination from "../_components/Pagination";
import { buildAuditEvents, filterAuditEvents, type AuditFilters, type UploadedByJoinRow } from "./utils";
import type { DeployedByJoinRow } from "../deployments/utils";

export default function AuditLogSection({
  deploys,
  docs,
  filters,
  page,
  pageSize,
}: {
  deploys: DeployedByJoinRow[];
  docs: UploadedByJoinRow[];
  filters: AuditFilters;
  page: number;
  pageSize: number;
}) {
  const allEvents = buildAuditEvents(deploys, docs);
  const filtered = filterAuditEvents(allEvents, filters);
  const total = filtered.length;
  const pageRows = filtered.slice((page - 1) * pageSize, page * pageSize);

  return (
    <div className="rounded-lg border bg-white">
      <AuditLogFilterBar />

      {pageRows.length === 0 ? (
        <p className="p-6 text-sm text-gray-500">
          {allEvents.length === 0 ? "No activity yet." : "No events match your filters."}
        </p>
      ) : (
        <AuditLogTable events={pageRows} />
      )}

      {total > 0 && (
        <Pagination page={page} pageSize={pageSize} total={total} paramPrefix="audit" itemLabel="event" />
      )}
    </div>
  );
}
