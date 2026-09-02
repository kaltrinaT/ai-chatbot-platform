import Link from "next/link";
import { redirect } from "next/navigation";
import { Activity as ActivityIcon } from "lucide-react";
import { auth } from "@/auth";
import { getAllDeploys, getAllDocs } from "../_data/queries";
import { buildActivity } from "../_data/selectors";
import ActivityList from "../_components/ActivityList";
import DashboardShell from "../_components/DashboardShell";

export default async function ActivityPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/signin");
  const ownerId = session.user.id;

  const [allDeploys, allDocs] = await Promise.all([getAllDeploys(ownerId), getAllDocs(ownerId)]);
  const items = buildActivity(allDeploys, allDocs);

  return (
    <DashboardShell active="activity">
      <div className="mx-auto max-w-7xl px-6 py-8">
        <Link href="/" className="text-sm text-gray-500 hover:underline">
          &larr; Back to dashboard
        </Link>
        <h1 className="mt-1 flex items-center gap-2 text-2xl font-semibold">
          <ActivityIcon className="h-6 w-6 text-blue-600" />
          Activity
        </h1>
        <p className="mb-6 text-sm text-gray-500">
          Every deployment and document upload across your chatbots.
        </p>

        <div className="rounded-lg border bg-white p-4">
          <ActivityList items={items} />
        </div>
      </div>
    </DashboardShell>
  );
}
