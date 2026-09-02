"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { BookOpen, ShieldCheck } from "lucide-react";
import { GUIDE_CATEGORIES } from "../categories";

export default function GuidesNav() {
  const pathname = usePathname();

  return (
    <aside className="hidden w-64 shrink-0 border-r bg-white md:block">
      <div className="sticky top-0 flex h-screen flex-col justify-between overflow-y-auto">
        <div>
          <div className="flex items-center gap-2 border-b px-5 py-5">
            <BookOpen className="h-4 w-4 text-blue-600" />
            <span className="text-sm font-semibold text-gray-900">Guides</span>
          </div>

          <nav className="flex flex-col gap-1 p-3">
            {GUIDE_CATEGORIES.map((c) => {
              const Icon = c.icon;
              const isActive = Boolean(c.href) && pathname === c.href;
              const disabled = !c.href;
              return (
                <Link
                  key={c.title}
                  href={c.href ?? "#"}
                  aria-disabled={disabled}
                  onClick={(e) => disabled && e.preventDefault()}
                  className={`flex items-center gap-2.5 rounded-md border-l-2 px-3 py-2 text-sm font-medium ${
                    isActive
                      ? "border-blue-600 bg-blue-50 text-blue-700"
                      : disabled
                        ? "cursor-not-allowed border-transparent text-gray-300"
                        : "border-transparent text-gray-600 hover:bg-gray-50"
                  }`}
                >
                  <Icon className="h-4 w-4 shrink-0" />
                  {c.title}
                </Link>
              );
            })}
          </nav>
        </div>

        <div className="border-t p-4">
          <div className="flex items-start gap-2 text-xs text-gray-500">
            <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-gray-400" />
            <div>
              <div className="font-medium text-gray-700">Read-only Guides</div>
              Informational content only. No tenant data or documents are accessed here.
            </div>
          </div>
        </div>
      </div>
    </aside>
  );
}
