import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { getActiveTenants, getAllDeploys, getAllDocs } from "./_data/queries";
import {
  buildActivity,
  buildAttentionItems,
  computeDashboardStats,
  computeGettingStartedSteps,
  latestDeployByTenant,
} from "./_data/selectors";
import type { TenantRow } from "./_data/queries";
import StatsRow from "./_components/StatsRow";
import DashboardShell from "./_components/DashboardShell";
import ChatbotsTable from "./_components/ChatbotsTable";
import AttentionList from "./_components/AttentionList";
import ActivityList from "./_components/ActivityList";
import GettingStarted from "./_components/GettingStarted";

const CHATBOTS_PREVIEW_COUNT = 6;
const ATTENTION_PREVIEW_COUNT = 4;
const ACTIVITY_PREVIEW_COUNT = 5;

export default async function DashboardPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/signin");
  const ownerId = session.user.id;

  const [activeTenants, allDeploysRaw, allDocs] = await Promise.all([
    getActiveTenants(ownerId),
    getAllDeploys(ownerId),
    getAllDocs(ownerId),
  ]);
  const latestByTenant = latestDeployByTenant(allDeploysRaw);

  const stats = computeDashboardStats(activeTenants, latestByTenant, allDocs);
  const chatbotsPreview = [...activeTenants]
    .sort((a: TenantRow, b: TenantRow) => b.createdAt.getTime() - a.createdAt.getTime())
    .slice(0, CHATBOTS_PREVIEW_COUNT);
  const attentionItems = buildAttentionItems(latestByTenant, allDocs);
  const activity = buildActivity(allDeploysRaw, allDocs);
  const gettingStarted = computeGettingStartedSteps(activeTenants, allDeploysRaw, allDocs);

  return (
    <DashboardShell active="dashboard">
      <div className="mx-auto max-w-7xl px-6 py-8">
        <header className="mb-6 flex items-center justify-between gap-6">
          <div>
            <h1 className="text-2xl font-semibold">
              Welcome back, {session.user.name ?? session.user.email}! 👋
            </h1>
            <p className="text-sm text-gray-500">Here&apos;s what&apos;s happening with your AI chatbots today.</p>
          </div>
          <div className="flex shrink-0 gap-3">
            {process.env.DEMO_CHATBOT_URL && (
              <a
                href={process.env.DEMO_CHATBOT_URL}
                target="_blank"
                rel="noreferrer"
                className="rounded-md border border-indigo-200 bg-indigo-50 px-4 py-2 text-sm font-medium text-indigo-700 hover:bg-indigo-100"
              >
                Demo chatbot ↗
              </a>
            )}
            <Link
              href="/tenants/new"
              className="rounded-md bg-black px-4 py-2 text-sm font-medium text-white hover:bg-gray-800"
            >
              Deploy new tenant
            </Link>
          </div>
        </header>

        <StatsRow stats={stats} />

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
          <div className="lg:col-span-2">
            <div className="rounded-lg border bg-white">
              <div className="flex items-center justify-between border-b px-4 py-3">
                <h2 className="text-sm font-semibold">Your Chatbots</h2>
                <p className="text-xs text-gray-500">Overview of all deployed chatbots</p>
              </div>

              {chatbotsPreview.length === 0 ? (
                <p className="p-6 text-sm text-gray-500">
                  No tenants yet. Click <span className="font-medium">Deploy new tenant</span> to provision
                  a chatbot stack into a customer AWS account.
                </p>
              ) : (
                <ChatbotsTable tenants={chatbotsPreview} latestDeployByTenant={latestByTenant} />
              )}

              <div className="border-t px-4 py-3 text-center">
                <Link href="/chatbots" className="text-sm text-blue-600 hover:underline">
                  View all chatbots &rarr;
                </Link>
              </div>
            </div>
          </div>

          <div className="space-y-6">
            <div className="rounded-lg border bg-white p-4">
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-sm font-semibold">
                  Attention Required
                  {attentionItems.length > 0 && (
                    <span className="ml-2 rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700">
                      {attentionItems.length}
                    </span>
                  )}
                </h2>
              </div>
              <AttentionList items={attentionItems.slice(0, ATTENTION_PREVIEW_COUNT)} />
              <div className="mt-3 border-t pt-3 text-center">
                <Link href="/issues" className="text-sm text-blue-600 hover:underline">
                  View all issues &rarr;
                </Link>
              </div>
            </div>

            <div className="rounded-lg border bg-white p-4">
              <h2 className="mb-3 text-sm font-semibold">Recent Activity</h2>
              <ActivityList items={activity.slice(0, ACTIVITY_PREVIEW_COUNT)} />
              <div className="mt-3 border-t pt-3 text-center">
                <Link href="/activity" className="text-sm text-blue-600 hover:underline">
                  View all activity &rarr;
                </Link>
              </div>
            </div>
          </div>
        </div>

        {/* <div className="mt-6">
          <QuickActions />
        </div> */}

        <div className="mt-6">
          <GettingStarted steps={gettingStarted} />
        </div>
      </div>
    </DashboardShell>
  );
}
