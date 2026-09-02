import DeploymentsStatsRow from "./DeploymentsStatsRow";
import DeploymentsFilterBar from "./DeploymentsFilterBar";
import DeploymentsTable, { type NumberedDeployment } from "./DeploymentsTable";
import Pagination from "../_components/Pagination";
import DeploymentDetailsPanel from "./DeploymentDetailsPanel";
import { filterDeployments, type DeployedByJoinRow, type DeploymentFilters } from "./utils";

export default async function DeploymentsSection({
  tenantId,
  region,
  allRows,
  filters,
  page,
  pageSize,
  selectedId,
}: {
  tenantId: string;
  region: string;
  allRows: DeployedByJoinRow[];
  filters: DeploymentFilters;
  page: number;
  pageSize: number;
  selectedId?: string;
}) {
  // allRows is newest-first; ordinals count up from the oldest so they stay
  // stable across pages/filters instead of just being a page-local index.
  const numbered: NumberedDeployment[] = allRows.map((r, i) => ({ ...r, ordinal: allRows.length - i }));

  const filtered = filterDeployments(numbered, filters) as NumberedDeployment[];
  const total = filtered.length;
  const pageRows = filtered.slice((page - 1) * pageSize, page * pageSize);

  const selected = selectedId ? numbered.find((r) => r.deployment.id === selectedId) : undefined;

  function detailHref(deploymentId: string): string {
    const params = new URLSearchParams();
    params.set("tab", "deployments");
    if (filters.status) params.set("deployStatus", filters.status);
    if (filters.range) params.set("deployRange", filters.range);
    if (pageSize !== 10) params.set("deployPageSize", String(pageSize));
    if (page > 1) params.set("deployPage", String(page));
    params.set("selected", deploymentId);
    return `/tenants/${tenantId}?${params.toString()}`;
  }

  function closeHref(): string {
    const params = new URLSearchParams();
    params.set("tab", "deployments");
    if (filters.status) params.set("deployStatus", filters.status);
    if (filters.range) params.set("deployRange", filters.range);
    if (pageSize !== 10) params.set("deployPageSize", String(pageSize));
    if (page > 1) params.set("deployPage", String(page));
    return `/tenants/${tenantId}?${params.toString()}`;
  }

  return (
    <div className="space-y-6">
      <DeploymentsStatsRow rows={numbered} />

      <div className="flex items-start gap-6">
        <div className="min-w-0 flex-1 rounded-lg border bg-white">
          <DeploymentsFilterBar />

          {pageRows.length === 0 ? (
            <p className="p-6 text-sm text-gray-500">
              {allRows.length === 0 ? "No deployments yet." : "No deployments match your filters."}
            </p>
          ) : (
            <DeploymentsTable rows={pageRows} region={region} detailHref={detailHref} selectedId={selectedId} />
          )}

          {total > 0 && (
            <Pagination
              page={page}
              pageSize={pageSize}
              total={total}
              paramPrefix="deploy"
              itemLabel="deployment"
              clearParams={["selected"]}
            />
          )}
        </div>

        {selected && (
          <DeploymentDetailsPanel
            deployment={selected.deployment}
            deployedByName={selected.deployedByName}
            region={region}
            ordinal={selected.ordinal}
            closeHref={closeHref()}
          />
        )}
      </div>
    </div>
  );
}
