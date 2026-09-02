"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Search, LayoutList, LayoutGrid, RotateCcw } from "lucide-react";

export default function ChatbotsFilterBar() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // Any change to search/status/sort/view resets to page 1 — staying on a
  // page number that may no longer exist under the new filter is confusing.
  function updateParams(updates: Record<string, string | null>) {
    const params = new URLSearchParams(searchParams.toString());
    for (const [key, value] of Object.entries(updates)) {
      if (value) params.set(key, value);
      else params.delete(key);
    }
    params.delete("page");
    router.push(`${pathname}?${params.toString()}`);
  }

  const q = searchParams.get("q") ?? "";
  const status = searchParams.get("status") ?? "all";
  const cloud = searchParams.get("cloud") ?? "all";
  const llm = searchParams.get("llm") ?? "all";
  const vectorStore = searchParams.get("vectorStore") ?? "all";
  const sort = searchParams.get("sort") ?? "last-deployment";
  const view = searchParams.get("view") === "grid" ? "grid" : "list";
  const hasActiveFilters = Boolean(q || status !== "all" || cloud !== "all" || llm !== "all" || vectorStore !== "all");

  return (
    <div className="flex flex-wrap items-center gap-3 border-b px-4 py-3">
      <form
        className="relative w-64"
        onSubmit={(e) => {
          e.preventDefault();
          const input = e.currentTarget.elements.namedItem("q") as HTMLInputElement;
          updateParams({ q: input.value || null });
        }}
      >
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
        <input
          key={q}
          type="text"
          name="q"
          defaultValue={q}
          placeholder="Search chatbots..."
          className="w-full rounded-md border py-2 pl-9 pr-3 text-sm"
        />
      </form>

      <select
        value={status}
        onChange={(e) => updateParams({ status: e.target.value === "all" ? null : e.target.value })}
        className="rounded-md border bg-white px-3 py-2 text-sm"
      >
        <option value="all">All Status</option>
        <option value="online">Online</option>
        <option value="deploying">Deploying</option>
        <option value="failed">Failed</option>
      </select>

      <select
        value={cloud}
        onChange={(e) => updateParams({ cloud: e.target.value === "all" ? null : e.target.value })}
        className="rounded-md border bg-white px-3 py-2 text-sm"
      >
        <option value="all">All Clouds</option>
        <option value="aws">AWS</option>
        <option value="azure">Azure</option>
      </select>

      <select
        value={llm}
        onChange={(e) => updateParams({ llm: e.target.value === "all" ? null : e.target.value })}
        className="rounded-md border bg-white px-3 py-2 text-sm"
      >
        <option value="all">All LLM Providers</option>
        <option value="openai">OpenAI</option>
        <option value="anthropic">Anthropic</option>
        <option value="openrouter">OpenRouter</option>
      </select>

      <select
        value={vectorStore}
        onChange={(e) => updateParams({ vectorStore: e.target.value === "all" ? null : e.target.value })}
        className="rounded-md border bg-white px-3 py-2 text-sm"
      >
        <option value="all">All Vector Stores</option>
        <option value="pinecone">Pinecone</option>
        <option value="pgvector">pgvector</option>
      </select>

      {hasActiveFilters && (
        <button
          type="button"
          onClick={() => updateParams({ q: null, status: null, cloud: null, llm: null, vectorStore: null })}
          className="flex items-center gap-1.5 rounded-md px-2 py-2 text-sm text-gray-500 hover:bg-gray-50 hover:text-gray-700"
        >
          <RotateCcw className="h-3.5 w-3.5" />
          Clear filters
        </button>
      )}

      <div className="ml-auto flex items-center gap-3">
        <select
          value={sort}
          onChange={(e) =>
            updateParams({ sort: e.target.value === "last-deployment" ? null : e.target.value })
          }
          className="rounded-md border bg-white px-3 py-2 text-sm"
        >
          <option value="last-deployment">Sort by: Last Deployment</option>
          <option value="name">Sort by: Name</option>
        </select>

        <div className="flex overflow-hidden rounded-md border">
          <button
            type="button"
            onClick={() => updateParams({ view: null })}
            aria-label="List view"
            className={`p-2 ${view === "list" ? "bg-blue-50 text-blue-600" : "text-gray-400 hover:bg-gray-50"}`}
          >
            <LayoutList className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => updateParams({ view: "grid" })}
            aria-label="Grid view"
            className={`border-l p-2 ${view === "grid" ? "bg-blue-50 text-blue-600" : "text-gray-400 hover:bg-gray-50"}`}
          >
            <LayoutGrid className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
