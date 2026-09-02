import type { ReactNode } from "react";
import DashboardSidebar, { type ActivePage } from "./DashboardSidebar";

// h-screen (not min-h-screen) + overflow-y-auto only on <main> keeps the
// sidebar fixed at exactly the viewport height, never scrolling itself,
// while the page content scrolls independently.
export default function DashboardShell({
  active,
  children,
}: {
  active: ActivePage;
  children: ReactNode;
}) {
  return (
    <div className="flex h-screen bg-gray-50">
      <DashboardSidebar active={active} />
      <main className="flex-1 overflow-x-hidden overflow-y-auto">{children}</main>
    </div>
  );
}
