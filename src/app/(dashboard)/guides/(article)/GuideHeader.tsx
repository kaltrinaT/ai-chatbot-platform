import type { LucideIcon } from "lucide-react";
import { GUIDE_TONE_STYLES, type GuideTone } from "../categories";
import GuideBreadcrumb from "./GuideBreadcrumb";
import PrintButton from "./PrintButton";

export default function GuideHeader({
  current,
  icon: Icon,
  tone,
  title,
  subtitle,
}: {
  current: string;
  icon: LucideIcon;
  tone: GuideTone;
  title: string;
  subtitle: string;
}) {
  return (
    <>
      <div className="flex items-center justify-between gap-4">
        <GuideBreadcrumb current={current} />
        <PrintButton />
      </div>

      <div className="mt-4 flex items-start gap-4">
        <div className={`flex h-14 w-14 shrink-0 items-center justify-center rounded-xl ${GUIDE_TONE_STYLES[tone]}`}>
          <Icon className="h-6 w-6" />
        </div>
        <div>
          <h1 className="text-2xl font-semibold">{title}</h1>
          <p className="mt-1 text-sm text-gray-500">{subtitle}</p>
        </div>
      </div>
    </>
  );
}
