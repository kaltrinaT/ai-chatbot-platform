import { redirect } from "next/navigation";
import { auth } from "@/auth";
import DashboardShell from "../_components/DashboardShell";
import GuidesGrid from "./GuidesGrid";

export default async function GuidesPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/signin");

  return (
    <DashboardShell active="guides">
      <div className="mx-auto max-w-7xl px-6 py-8">
        <h1 className="text-2xl font-semibold">Guides</h1>
        <p className="mt-1 text-sm text-gray-500">
          Find step-by-step guides and documentation to help you deploy and manage your AI chatbots.
        </p>

        <div className="mt-6">
          <GuidesGrid />
        </div>
      </div>
    </DashboardShell>
  );
}
