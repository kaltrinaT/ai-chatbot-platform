import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import DashboardShell from "../../_components/DashboardShell";
import GuidesNav from "./GuidesNav";

export default async function GuideArticleLayout({ children }: { children: ReactNode }) {
  const session = await auth();
  if (!session?.user?.id) redirect("/signin");

  return (
    <DashboardShell active="guides">
      <div className="flex">
        <GuidesNav />
        <div className="min-w-0 flex-1">{children}</div>
      </div>
    </DashboardShell>
  );
}
