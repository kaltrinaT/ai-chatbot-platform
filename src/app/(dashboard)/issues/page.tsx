import Link from "next/link";
import { redirect } from "next/navigation";
import { AlertTriangle } from "lucide-react";
import { auth } from "@/auth";
import { getAllDeploys, getAllDocs } from "../_data/queries";
import { buildAttentionItems, latestDeployByTenant } from "../_data/selectors";
import AttentionList from "../_components/AttentionList";
import DashboardShell from "../_components/DashboardShell";

export default async function IssuesPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/signin");
  const ownerId = session.user.id;

  const [allDeploys, allDocs] = await Promise.all([getAllDeploys(ownerId), getAllDocs(ownerId)]);
  const items = buildAttentionItems(latestDeployByTenant(allDeploys), allDocs);

  return (
    <DashboardShell active="dashboard">
      <div className="mx-auto max-w-7xl px-6 py-8">
        <Link href="/" className="text-sm text-gray-500 hover:underline">
          &larr; Back to dashboard
        </Link>
        <h1 className="mt-1 flex items-center gap-2 text-2xl font-semibold">
          <AlertTriangle className="h-6 w-6 text-amber-600" />
          Issues
        </h1>
        <p className="mb-6 text-sm text-gray-500">Everything across your chatbots that needs attention.</p>

        <div className="rounded-lg border bg-white p-4">
          <AttentionList items={items} />
        </div>
      </div>
    </DashboardShell>
  );
}
