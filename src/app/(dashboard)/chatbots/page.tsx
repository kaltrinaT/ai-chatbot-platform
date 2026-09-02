import Link from "next/link";
import { redirect } from "next/navigation";
import { Plus, ChevronLeft, ChevronRight } from "lucide-react";
import { auth } from "@/auth";
import { getAllDeploys, getAllDocs, getTenantsForOwner } from "../_data/queries";
import {
  computeChatbotsPageStats,
  filterAndSortTenants,
  latestDeployByTenant,
  type ChatbotSort,
  type ChatbotStatusFilter,
} from "../_data/selectors";
import ChatbotsStatsRow from "../_components/ChatbotsStatsRow";
import ChatbotsFilterBar from "../_components/ChatbotsFilterBar";
import ChatbotsTable from "../_components/ChatbotsTable";
import ChatbotsGrid from "../_components/ChatbotsGrid";
import DashboardShell from "../_components/DashboardShell";

const PAGE_SIZE = 20;
const STATUS_FILTERS: ChatbotStatusFilter[] = ["all", "online", "deploying", "failed", "never-deployed"];
const SORTS: ChatbotSort[] = ["last-deployment", "name"];
const CLOUDS = ["aws", "azure"] as const;
const LLM_PROVIDERS = ["openai", "anthropic", "openrouter"] as const;
const VECTOR_STORES = ["pinecone", "pgvector"] as const;

export default async function ChatbotsPage({
  searchParams,
}: {
  searchParams: Promise<{
    tab?: string;
    page?: string;
    q?: string;
    status?: string;
    cloud?: string;
    llm?: string;
    vectorStore?: string;
    sort?: string;
    view?: string;
  }>;
}) {
  const session = await auth();
  if (!session?.user?.id) redirect("/signin");
  const ownerId = session.user.id;

  const {
    tab,
    page: pageParam,
    q,
    status: statusParam,
    cloud: cloudParam,
    llm: llmParam,
    vectorStore: vectorStoreParam,
    sort: sortParam,
    view: viewParam,
  } = await searchParams;
  const showDeleted = tab === "deleted";
  const page = Math.max(1, Number(pageParam) || 1);
  const status: ChatbotStatusFilter = STATUS_FILTERS.includes(statusParam as ChatbotStatusFilter)
    ? (statusParam as ChatbotStatusFilter)
    : "all";
  const sort: ChatbotSort = SORTS.includes(sortParam as ChatbotSort) ? (sortParam as ChatbotSort) : "last-deployment";
  const view = viewParam === "grid" ? "grid" : "list";
  const cloud = CLOUDS.find((c) => c === cloudParam);
  const llmProvider = LLM_PROVIDERS.find((p) => p === llmParam);
  const vectorStore = VECTOR_STORES.find((v) => v === vectorStoreParam);
  const hasAnyFilter = Boolean(q || status !== "all" || cloud || llmProvider || vectorStore);

  // Every link on this page (tabs, pagination) needs to preserve whichever
  // of these params are currently active, only changing the one it controls.
  function buildHref({ tab: wantDeleted = showDeleted, page: p = page }: { tab?: boolean; page?: number } = {}): string {
    const params = new URLSearchParams();
    if (wantDeleted) params.set("tab", "deleted");
    if (q) params.set("q", q);
    if (status !== "all") params.set("status", status);
    if (cloud) params.set("cloud", cloud);
    if (llmProvider) params.set("llm", llmProvider);
    if (vectorStore) params.set("vectorStore", vectorStore);
    if (sort !== "last-deployment") params.set("sort", sort);
    if (view === "grid") params.set("view", "grid");
    if (p > 1) params.set("page", String(p));
    const qs = params.toString();
    return qs ? `/chatbots?${qs}` : "/chatbots";
  }
  const pageHref = (p: number) => buildHref({ page: p });
  const tabHref = (deleted: boolean) => buildHref({ tab: deleted, page: 1 });

  const [matchingTenants, allDeploys, allDocs] = await Promise.all([
    getTenantsForOwner(ownerId, { showDeleted, search: q, cloud, llmProvider, vectorStore }),
    getAllDeploys(ownerId),
    getAllDocs(ownerId),
  ]);
  const latestByTenant = latestDeployByTenant(allDeploys);
  const stats = computeChatbotsPageStats(matchingTenants, latestByTenant, allDocs);

  const filtered = filterAndSortTenants(matchingTenants, latestByTenant, { status, sort });
  const total = filtered.length;
  const pageTenants = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const hasNextPage = page * PAGE_SIZE < total;
  const hasPrevPage = page > 1;
  const showingFrom = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const showingTo = Math.min(page * PAGE_SIZE, total);

  return (
    <DashboardShell active="chatbots">
      <div className="mx-auto max-w-7xl px-6 py-8">
        <header className="mb-6 flex items-center justify-between gap-6">
          <div>
            <h1 className="text-2xl font-semibold">All Chatbots</h1>
            <p className="text-sm text-gray-500">Manage and monitor all your deployed chatbots in one place.</p>
          </div>
          <Link
            href="/tenants/new"
            className="flex items-center gap-1.5 rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
          >
            <Plus className="h-4 w-4" />
            New Chatbot
          </Link>
        </header>

        <ChatbotsStatsRow stats={stats} />

        <div className="rounded-lg border bg-white">
          <div className="flex items-center gap-1 border-b px-4 pt-3">
            <Link
              href={tabHref(false)}
              className={`rounded-md px-3 py-1.5 text-sm font-medium ${
                !showDeleted ? "bg-gray-100 text-black" : "text-gray-500 hover:text-gray-700"
              }`}
            >
              Active
            </Link>
            <Link
              href={tabHref(true)}
              className={`rounded-md px-3 py-1.5 text-sm font-medium ${
                showDeleted ? "bg-gray-100 text-black" : "text-gray-500 hover:text-gray-700"
              }`}
            >
              Deleted
            </Link>
          </div>

          <ChatbotsFilterBar />

          {pageTenants.length === 0 ? (
            <p className="p-6 text-sm text-gray-500">
              {matchingTenants.length === 0 && !hasAnyFilter ? (
                showDeleted ? (
                  "No deleted tenants."
                ) : (
                  <>
                    No tenants yet. Click <span className="font-medium">New Chatbot</span> to provision a
                    chatbot stack into a customer AWS account.
                  </>
                )
              ) : (
                "No chatbots match your search/filters."
              )}
            </p>
          ) : view === "grid" ? (
            <ChatbotsGrid tenants={pageTenants} latestDeployByTenant={latestByTenant} />
          ) : (
            <ChatbotsTable tenants={pageTenants} latestDeployByTenant={latestByTenant} />
          )}

          {total > 0 && (
            <div className="flex items-center justify-between border-t px-4 py-3 text-sm">
              <span className="text-gray-500">
                Showing {showingFrom} to {showingTo} of {total} chatbot{total === 1 ? "" : "s"}
              </span>
              <div className="flex items-center gap-2">
                <Link
                  href={pageHref(page - 1)}
                  aria-disabled={!hasPrevPage}
                  className={`flex h-8 w-8 items-center justify-center rounded-md border ${
                    hasPrevPage ? "text-gray-600 hover:bg-gray-50" : "pointer-events-none text-gray-300"
                  }`}
                >
                  <ChevronLeft className="h-4 w-4" />
                </Link>
                <span className="flex h-8 w-8 items-center justify-center rounded-md bg-blue-600 text-xs font-medium text-white">
                  {page}
                </span>
                <Link
                  href={pageHref(page + 1)}
                  aria-disabled={!hasNextPage}
                  className={`flex h-8 w-8 items-center justify-center rounded-md border ${
                    hasNextPage ? "text-gray-600 hover:bg-gray-50" : "pointer-events-none text-gray-300"
                  }`}
                >
                  <ChevronRight className="h-4 w-4" />
                </Link>
              </div>
            </div>
          )}
        </div>
      </div>
    </DashboardShell>
  );
}
