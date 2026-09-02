import type { LucideIcon } from "lucide-react";

export type StatTileTone = "blue" | "green" | "purple" | "orange" | "yellow" | "red" | "gray";

export const TONE_STYLES: Record<StatTileTone, string> = {
  blue: "bg-blue-100 text-blue-600",
  green: "bg-green-100 text-green-600",
  purple: "bg-purple-100 text-purple-600",
  orange: "bg-orange-100 text-orange-600",
  yellow: "bg-yellow-100 text-yellow-600",
  red: "bg-red-100 text-red-600",
  gray: "bg-gray-100 text-gray-600",
};

export default function StatTile({
  icon: Icon,
  label,
  value,
  sublabel,
  tone,
}: {
  icon: LucideIcon;
  label: string;
  value: string | number;
  sublabel?: string;
  tone: StatTileTone;
}) {
  return (
    <div className="rounded-lg border bg-white p-4">
      <div className="flex items-center gap-3">
        <div
          className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full ${TONE_STYLES[tone]}`}
        >
          <Icon className="h-5 w-5" />
        </div>
        <div className="min-w-0">
          <div className="text-xs text-gray-500">{label}</div>
          <div className="text-xl font-semibold">{value}</div>
        </div>
      </div>
      {sublabel && <div className="mt-2 text-xs text-gray-500">{sublabel}</div>}
    </div>
  );
}
