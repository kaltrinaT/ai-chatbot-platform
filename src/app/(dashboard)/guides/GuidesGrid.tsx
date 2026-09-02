"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Search, ArrowRight, Clock } from "lucide-react";
import { GUIDE_CATEGORIES, GUIDE_TONE_STYLES } from "./categories";

export default function GuidesGrid() {
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "/" && e.ctrlKey) {
        e.preventDefault();
        inputRef.current?.focus();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const q = query.trim().toLowerCase();
  const filtered = q
    ? GUIDE_CATEGORIES.filter((c) => c.title.toLowerCase().includes(q) || c.description.toLowerCase().includes(q))
    : GUIDE_CATEGORIES;

  return (
    <div>
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search guides and documentation..."
          className="w-full rounded-lg border bg-white py-3 pl-10 pr-16 text-sm placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        <kbd className="pointer-events-none absolute right-3 top-1/2 flex -translate-y-1/2 items-center gap-1 rounded border bg-gray-50 px-1.5 py-0.5 text-xs text-gray-400">
          Ctrl /
        </kbd>
      </div>

      <h2 className="mb-3 mt-8 text-sm font-semibold text-gray-900">All Guides</h2>

      {filtered.length === 0 ? (
        <p className="rounded-lg border bg-white p-6 text-center text-sm text-gray-500">
          No guides match &quot;{query}&quot;.
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {filtered.map((c) => {
            const Icon = c.icon;
            const cardClassName = `rounded-lg border bg-white p-5 ${c.href ? "hover:border-blue-300 hover:shadow-sm" : ""}`;
            const content = (
              <>
                <div className={`flex h-11 w-11 items-center justify-center rounded-lg ${GUIDE_TONE_STYLES[c.tone]}`}>
                  <Icon className="h-5 w-5" />
                </div>
                <h3 className="mt-3 text-sm font-semibold text-gray-900">{c.title}</h3>
                <p className="mt-1.5 text-xs leading-relaxed text-gray-500">{c.description}</p>
                {c.href ? (
                  <div className="mt-3 flex items-center gap-1 text-xs font-medium text-blue-600">
                    View Guide
                    <ArrowRight className="h-3.5 w-3.5" />
                  </div>
                ) : (
                  <div className="mt-3 flex items-center gap-1.5 text-xs text-gray-400">
                    <Clock className="h-3.5 w-3.5" />
                    Coming soon
                  </div>
                )}
              </>
            );
            return c.href ? (
              <Link key={c.title} href={c.href} className={cardClassName}>
                {content}
              </Link>
            ) : (
              <div key={c.title} className={cardClassName}>
                {content}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
