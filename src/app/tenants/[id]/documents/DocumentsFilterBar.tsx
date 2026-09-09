"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Search, RefreshCw } from "lucide-react";

export default function DocumentsFilterBar({ typeOptions }: { typeOptions: string[] }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  function updateParams(updates: Record<string, string | null>) {
    const params = new URLSearchParams(searchParams.toString());
    for (const [key, value] of Object.entries(updates)) {
      if (value) params.set(key, value);
      else params.delete(key);
    }
    params.delete("docPage");
    router.push(`${pathname}?${params.toString()}`);
  }

  const docQuery = searchParams.get("docQuery") ?? "";
  const docStatus = searchParams.get("docStatus") ?? "all";
  const docType = searchParams.get("docType") ?? "all";

  return (
    <div className="flex flex-wrap items-center gap-3 border-b px-4 py-3">
      <form
        className="relative w-64"
        onSubmit={(e) => {
          e.preventDefault();
          const input = e.currentTarget.elements.namedItem("docQuery") as HTMLInputElement;
          updateParams({ docQuery: input.value || null });
        }}
      >
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
        <input
          key={docQuery}
          type="text"
          name="docQuery"
          defaultValue={docQuery}
          placeholder="Search documents..."
          className="w-full rounded-md border py-2 pl-9 pr-3 text-sm"
        />
      </form>

      <select
        value={docStatus}
        onChange={(e) => updateParams({ docStatus: e.target.value === "all" ? null : e.target.value })}
        className="rounded-md border bg-white px-3 py-2 text-sm"
      >
        <option value="all">All Status</option>
        <option value="uploaded">Uploaded</option>
        <option value="pending">Pending</option>
        <option value="failed">Failed</option>
      </select>

      <select
        value={docType}
        onChange={(e) => updateParams({ docType: e.target.value === "all" ? null : e.target.value })}
        className="rounded-md border bg-white px-3 py-2 text-sm"
      >
        <option value="all">All Types</option>
        {typeOptions.map((t) => (
          <option key={t} value={t}>
            {t}
          </option>
        ))}
      </select>

      <div className="ml-auto flex items-center gap-2">
        <button
          type="button"
          onClick={() => router.refresh()}
          className="flex items-center gap-1.5 rounded-md border px-3 py-2 text-sm font-medium text-gray-600 hover:bg-gray-50"
        >
          <RefreshCw className="h-3.5 w-3.5" />
          Refresh
        </button>
      </div>
    </div>
  );
}
