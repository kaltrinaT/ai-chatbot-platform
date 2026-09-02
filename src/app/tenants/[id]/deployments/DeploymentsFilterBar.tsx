"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { RotateCcw } from "lucide-react";

export default function DeploymentsFilterBar() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  function updateParams(updates: Record<string, string | null>) {
    const params = new URLSearchParams(searchParams.toString());
    for (const [key, value] of Object.entries(updates)) {
      if (value) params.set(key, value);
      else params.delete(key);
    }
    params.delete("deployPage");
    params.delete("selected");
    router.push(`${pathname}?${params.toString()}`);
  }

  const range = searchParams.get("deployRange") ?? "30d";
  const status = searchParams.get("deployStatus") ?? "all";
  const hasActiveFilters = range !== "30d" || status !== "all";

  return (
    <div className="flex flex-wrap items-center gap-3 border-b px-4 py-3">
      <select
        value={range}
        onChange={(e) => updateParams({ deployRange: e.target.value === "30d" ? null : e.target.value })}
        className="rounded-md border bg-white px-3 py-2 text-sm"
      >
        <option value="7d">Last 7 days</option>
        <option value="30d">Last 30 days</option>
        <option value="90d">Last 90 days</option>
        <option value="all">All time</option>
      </select>

      <select
        value={status}
        onChange={(e) => updateParams({ deployStatus: e.target.value === "all" ? null : e.target.value })}
        className="rounded-md border bg-white px-3 py-2 text-sm"
      >
        <option value="all">All Statuses</option>
        <option value="succeeded">Succeeded</option>
        <option value="running">In Progress</option>
        <option value="failed">Failed</option>
      </select>

      {hasActiveFilters && (
        <button
          type="button"
          onClick={() => updateParams({ deployRange: null, deployStatus: null })}
          className="flex items-center gap-1.5 rounded-md px-2 py-2 text-sm text-gray-500 hover:bg-gray-50 hover:text-gray-700"
        >
          <RotateCcw className="h-3.5 w-3.5" />
          Clear filters
        </button>
      )}
    </div>
  );
}
