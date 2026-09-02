"use client";

import { Printer } from "lucide-react";

export default function PrintButton() {
  return (
    <button
      type="button"
      onClick={() => window.print()}
      className="flex items-center gap-1.5 rounded-md border px-3 py-2 text-sm font-medium hover:bg-gray-50"
    >
      <Printer className="h-4 w-4" />
      Print
    </button>
  );
}
