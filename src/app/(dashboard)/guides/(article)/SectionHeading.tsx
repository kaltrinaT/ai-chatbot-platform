export default function SectionHeading({
  n,
  title,
  size = "sm",
}: {
  n: number;
  title: string;
  size?: "sm" | "base";
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-blue-600 text-xs font-semibold text-white">
        {n}
      </span>
      <h2 className={`${size === "base" ? "text-base" : "text-sm"} font-semibold text-gray-900`}>{title}</h2>
    </div>
  );
}
