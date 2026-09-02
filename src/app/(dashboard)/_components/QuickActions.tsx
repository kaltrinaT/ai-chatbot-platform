import Link from "next/link";
import { Bot, Rocket, UploadCloud, RefreshCw, ArrowRight } from "lucide-react";

// "Deploy Chatbot"/"Upload Documents"/"Redeploy" all land on the chatbots
// list rather than acting directly — there's no tenant-picker modal, so the
// list itself is the real "pick which chatbot" step before each of those.
const QUICK_ACTIONS = [
  {
    label: "New Chatbot",
    description: "Create and configure a new chatbot",
    href: "/tenants/new",
    icon: Bot,
    tone: "blue" as const,
  },
  {
    label: "Deploy Chatbot",
    description: "Start a new deployment for a chatbot",
    href: "/chatbots",
    icon: Rocket,
    tone: "green" as const,
  },
  {
    label: "Upload Documents",
    description: "Add documents to a chatbot",
    href: "/chatbots",
    icon: UploadCloud,
    tone: "purple" as const,
  },
  {
    label: "Redeploy",
    description: "Redeploy an existing chatbot",
    href: "/chatbots",
    icon: RefreshCw,
    tone: "orange" as const,
  },
];

const TONE_STYLES = {
  blue: "bg-blue-100 text-blue-600",
  green: "bg-green-100 text-green-600",
  purple: "bg-purple-100 text-purple-600",
  orange: "bg-orange-100 text-orange-600",
} as const;

export default function QuickActions() {
  return (
    <div className="rounded-lg border bg-white p-4">
      <h2 className="mb-3 text-sm font-semibold">Quick Actions</h2>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {QUICK_ACTIONS.map(({ label, description, href, icon: Icon, tone }) => (
          <Link
            key={label}
            href={href}
            className="group flex items-start gap-3 rounded-lg border p-4 hover:border-gray-300 hover:bg-gray-50"
          >
            <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${TONE_STYLES[tone]}`}>
              <Icon className="h-5 w-5" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1 text-sm font-medium text-gray-900">
                {label}
                <ArrowRight className="h-3.5 w-3.5 shrink-0 text-gray-400 transition-transform group-hover:translate-x-0.5" />
              </div>
              <div className="text-xs text-gray-500">{description}</div>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
