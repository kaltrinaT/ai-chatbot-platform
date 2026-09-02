import Link from "next/link";
import { Home } from "lucide-react";

export default function GuideBreadcrumb({ current }: { current: string }) {
  return (
    <div className="flex items-center gap-1.5 text-sm text-gray-500">
      <Link href="/" className="flex items-center hover:text-gray-700" aria-label="Dashboard">
        <Home className="h-3.5 w-3.5" />
      </Link>
      <span>&gt;</span>
      <Link href="/guides" className="text-blue-600 hover:underline">
        Guides
      </Link>
      <span>&gt;</span>
      <span className="text-gray-700">{current}</span>
    </div>
  );
}
