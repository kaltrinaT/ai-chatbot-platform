"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ChevronsLeft, ChevronLeft, ChevronRight, ChevronsRight } from "lucide-react";

// Shared numbered pagination + rows-per-page selector, driven entirely by
// `${paramPrefix}Page`/`${paramPrefix}PageSize` search params so each tab
// (Deployments, Audit Log, ...) keeps its own independent page state.
export default function Pagination({
  page,
  pageSize,
  total,
  paramPrefix,
  itemLabel,
  clearParams = [],
}: {
  page: number;
  pageSize: number;
  total: number;
  paramPrefix: string;
  itemLabel: string;
  // Extra search params to drop whenever the page/page-size changes, e.g. a
  // selected-row param that no longer makes sense once the page shifts.
  clearParams?: string[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const showingFrom = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const showingTo = Math.min(page * pageSize, total);
  const pageParam = `${paramPrefix}Page`;
  const pageSizeParam = `${paramPrefix}PageSize`;

  function hrefFor(p: number, size = pageSize): string {
    const params = new URLSearchParams(searchParams.toString());
    if (size !== 10) params.set(pageSizeParam, String(size));
    else params.delete(pageSizeParam);
    if (p > 1) params.set(pageParam, String(p));
    else params.delete(pageParam);
    for (const key of clearParams) params.delete(key);
    return `${pathname}?${params.toString()}`;
  }

  // A window of up to 5 page numbers centered on the current page.
  const windowStart = Math.max(1, Math.min(page - 2, totalPages - 4));
  const pageNumbers = Array.from(
    { length: Math.min(5, totalPages) },
    (_, i) => windowStart + i,
  ).filter((p) => p <= totalPages);

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t px-4 py-3 text-sm">
      <span className="text-gray-500">
        Showing {showingFrom} to {showingTo} of {total} {itemLabel}
        {total === 1 ? "" : "s"}
      </span>

      <div className="flex items-center gap-1">
        <PageButton href={hrefFor(1)} disabled={page === 1} label="First page">
          <ChevronsLeft className="h-4 w-4" />
        </PageButton>
        <PageButton href={hrefFor(page - 1)} disabled={page === 1} label="Previous page">
          <ChevronLeft className="h-4 w-4" />
        </PageButton>
        {pageNumbers.map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => router.push(hrefFor(p))}
            className={`flex h-8 w-8 items-center justify-center rounded-md text-xs font-medium ${
              p === page ? "bg-blue-600 text-white" : "border text-gray-600 hover:bg-gray-50"
            }`}
          >
            {p}
          </button>
        ))}
        <PageButton href={hrefFor(page + 1)} disabled={page === totalPages} label="Next page">
          <ChevronRight className="h-4 w-4" />
        </PageButton>
        <PageButton href={hrefFor(totalPages)} disabled={page === totalPages} label="Last page">
          <ChevronsRight className="h-4 w-4" />
        </PageButton>
      </div>

      <div className="flex items-center gap-2 text-gray-500">
        Rows per page:
        <select
          value={pageSize}
          onChange={(e) => router.push(hrefFor(1, Number(e.target.value)))}
          className="rounded-md border bg-white px-2 py-1 text-sm text-gray-700"
        >
          <option value={10}>10</option>
          <option value={20}>20</option>
          <option value={50}>50</option>
        </select>
      </div>
    </div>
  );
}

function PageButton({
  href,
  disabled,
  label,
  children,
}: {
  href: string;
  disabled: boolean;
  label: string;
  children: React.ReactNode;
}) {
  const router = useRouter();
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={() => router.push(href)}
      className={`flex h-8 w-8 items-center justify-center rounded-md border ${
        disabled ? "cursor-not-allowed text-gray-300" : "text-gray-600 hover:bg-gray-50"
      }`}
    >
      {children}
    </button>
  );
}
