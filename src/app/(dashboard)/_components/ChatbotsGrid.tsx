import Link from "next/link";
import { Badge } from "../../Badge";
import { estimateMonthlyCost } from "@/lib/pricing";
import type { TenantRow, DeployJoinRow } from "../_data/queries";
import { avatarInitials, avatarTone, chatbotStatus } from "../_data/selectors";
import { TONE_STYLES } from "./StatTile";
import { CloudLogo, LlmLogo, VectorStoreLogo, llmProviderLabel } from "./ProviderLogo";

export default function ChatbotsGrid({
  tenants,
  latestDeployByTenant,
}: {
  tenants: TenantRow[];
  latestDeployByTenant: Map<string, DeployJoinRow>;
}) {
  return (
    <div className="grid grid-cols-1 gap-4 p-4 sm:grid-cols-2 lg:grid-cols-3">
      {tenants.map((t) => {
        const latest = latestDeployByTenant.get(t.id)?.deployment;
        const status = t.deletedAt
          ? { label: "Deleted", tone: "gray" as const }
          : chatbotStatus(latest);
        const cost = estimateMonthlyCost(t.cloudProvider, t.vectorStore);
        const canOpen = !t.deletedAt && status.label === "Online" && t.chatbotUrl;

        return (
          <div key={t.id} className="rounded-lg border p-4">
            <div className="flex items-start justify-between gap-2">
              <div className="flex items-center gap-3">
                <div
                  className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${TONE_STYLES[avatarTone(t.id)]}`}
                >
                  {avatarInitials(t.name)}
                </div>
                <div className="min-w-0">
                  <Link
                    href={`/tenants/${t.id}`}
                    className="block truncate font-medium text-gray-900 hover:text-blue-600 hover:underline"
                  >
                    {t.name}
                  </Link>
                  <div className="text-xs text-gray-500">{t.slug}</div>
                </div>
              </div>
              <Badge label={status.label} tone={status.tone} />
            </div>

            <dl className="mt-4 space-y-1 text-xs text-gray-600">
              <div className="flex items-center justify-between">
                <dt className="text-gray-400">Cloud</dt>
                <dd className="flex items-center gap-1.5">
                  <CloudLogo provider={t.cloudProvider} />
                  {t.cloudProvider === "aws" ? (t.awsRegion ?? "—") : (t.azureRegion ?? "—")}
                </dd>
              </div>
              <div className="flex items-center justify-between">
                <dt className="text-gray-400">LLM Provider</dt>
                <dd className="flex items-center gap-1.5 text-right">
                  <LlmLogo provider={t.llmProvider} />
                  <span>
                    {llmProviderLabel(t.llmProvider)}
                    {t.llmModel && <span className="block text-gray-400">{t.llmModel}</span>}
                  </span>
                </dd>
              </div>
              <div className="flex items-center justify-between">
                <dt className="text-gray-400">Vector Store</dt>
                <dd className="flex items-center gap-1.5">
                  <VectorStoreLogo store={t.vectorStore} />
                  {t.vectorStore}
                </dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-gray-400">Last Deployment</dt>
                <dd>
                  {t.deletedAt
                    ? `deleted ${t.deletedAt.toLocaleString()}`
                    : (latest?.startedAt.toLocaleString() ?? "—")}
                </dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-gray-400">Est. Monthly Cost</dt>
                <dd>
                  ${cost.totalLow}–${cost.totalHigh}
                </dd>
              </div>
            </dl>

            <div className="mt-4 flex items-center justify-end border-t pt-3 text-sm">
              {canOpen ? (
                <a
                  href={t.chatbotUrl!}
                  target="_blank"
                  rel="noreferrer"
                  className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700"
                >
                  Open
                </a>
              ) : (
                <Link
                  href={`/tenants/${t.id}`}
                  className="rounded-md border px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50"
                >
                  Manage
                </Link>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
