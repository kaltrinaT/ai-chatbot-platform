"use client";

import { useSyncExternalStore } from "react";
import Link from "next/link";
import {
  Bot,
  LayoutDashboard,
  MessageSquare,
  Activity,
  BookOpen,
  LogOut,
  ChevronLeft,
  ChevronRight,
  type LucideIcon,
} from "lucide-react";
import { signOutAction } from "../actions";

const STORAGE_KEY = "sidebar-collapsed";

// Collapsed state lives in localStorage; useSyncExternalStore (rather than
// reading it in a useEffect + setState) avoids an extra render pass and is
// the React-recommended way to read/subscribe to an external store like this
// without a hydration mismatch (the server snapshot is always "expanded").
const collapseListeners = new Set<() => void>();

function getCollapsedSnapshot(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function getCollapsedServerSnapshot(): boolean {
  return false;
}

function subscribeToCollapsed(callback: () => void): () => void {
  collapseListeners.add(callback);
  return () => collapseListeners.delete(callback);
}

function setCollapsedPersisted(next: boolean) {
  try {
    localStorage.setItem(STORAGE_KEY, next ? "1" : "0");
  } catch {
    // Best-effort persistence only.
  }
  collapseListeners.forEach((listener) => listener());
}

export type ActivePage = "dashboard" | "chatbots" | "activity" | "guides";

const NAV_LINKS: { key: ActivePage; label: string; href: string; icon: LucideIcon }[] = [
  { key: "dashboard", label: "Dashboard", href: "/", icon: LayoutDashboard },
  { key: "chatbots", label: "Chatbots", href: "/chatbots", icon: MessageSquare },
  { key: "activity", label: "Activity", href: "/activity", icon: Activity },
  { key: "guides", label: "Guides", href: "/guides", icon: BookOpen },
];

export default function DashboardSidebar({ active }: { active: ActivePage }) {
  const collapsed = useSyncExternalStore(
    subscribeToCollapsed,
    getCollapsedSnapshot,
    getCollapsedServerSnapshot,
  );

  function toggleCollapsed() {
    setCollapsedPersisted(!collapsed);
  }

  return (
    <aside
      // Fixed to the viewport height and never scrolls itself — only <main>
      // scrolls. Collapsed, the whole rail expands on click (not just the
      // chevron button), except nav links stop propagation so a click on a
      // nav icon navigates in place instead of also forcing the sidebar
      // open. This only ever sets collapsed -> expanded (never the
      // reverse), so it can't fight with a click on the toggle button.
      onClick={() => {
        if (collapsed) setCollapsedPersisted(false);
      }}
      className={`sticky top-0 flex h-screen shrink-0 flex-col justify-between overflow-hidden border-r bg-slate-900 text-slate-100 transition-[width] duration-150 ${
        collapsed ? "w-16 cursor-pointer" : "w-64"
      }`}
    >
      <div>
        <div
          className={`flex items-center gap-2 border-b border-slate-800 px-5 py-5 ${collapsed ? "justify-center px-3" : ""}`}
        >
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-blue-600">
            <Bot className="h-5 w-5 text-white" />
          </div>
          {!collapsed && (
            <div>
              <div className="text-sm font-semibold leading-tight">AI Chatbot</div>
              <div className="text-xs leading-tight text-slate-400">Deployment Platform</div>
            </div>
          )}
        </div>

        <nav className="flex flex-col gap-1 px-3 py-4">
          {NAV_LINKS.map(({ key, label, href, icon: Icon }) => (
            <Link
              key={key}
              href={href}
              title={collapsed ? label : undefined}
              // Stop the click from bubbling to the <aside> expand handler:
              // collapsed, this link should navigate in place, not also
              // force the sidebar open.
              onClick={(e) => e.stopPropagation()}
              className={`flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium ${
                collapsed ? "justify-center" : ""
              } ${active === key ? "bg-blue-600 text-white" : "text-slate-300 hover:bg-slate-800"}`}
            >
              <Icon className="h-4 w-4 shrink-0" />
              {!collapsed && label}
            </Link>
          ))}
        </nav>
      </div>

      <div className="border-t border-slate-800 p-4">
        {!collapsed && (
          <div className="rounded-md bg-slate-800 p-3">
            <div className="text-xs text-slate-400">Platform Plan</div>
            <div className="mt-1 flex items-center justify-between">
              <span className="text-sm font-medium">Research Prototype</span>
              <span className="rounded-full bg-green-900 px-2 py-0.5 text-[10px] font-medium text-green-300">
                Active
              </span>
            </div>
          </div>
        )}
        <form action={signOutAction}>
          <button
            type="submit"
            title={collapsed ? "Sign out" : undefined}
            className={`mt-3 flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm font-medium text-slate-300 hover:bg-slate-800 ${
              collapsed ? "justify-center" : ""
            }`}
          >
            <LogOut className="h-4 w-4 shrink-0" />
            {!collapsed && "Sign out"}
          </button>
        </form>
        <button
          type="button"
          onClick={toggleCollapsed}
          title={collapsed ? "Expand sidebar" : undefined}
          className={`mt-1 flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm font-medium text-slate-400 hover:bg-slate-800 ${
            collapsed ? "justify-center" : ""
          }`}
        >
          {collapsed ? <ChevronRight className="h-4 w-4 shrink-0" /> : <ChevronLeft className="h-4 w-4 shrink-0" />}
          {!collapsed && "Collapse"}
        </button>
      </div>
    </aside>
  );
}
