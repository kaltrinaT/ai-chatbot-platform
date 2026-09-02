import Link from "next/link";
import { Badge } from "../../Badge";
import { estimateMonthlyCost } from "@/lib/pricing";
import type { TenantRow, DeployJoinRow } from "../_data/queries";
import { avatarInitials, avatarTone, chatbotStatus } from "../_data/selectors";
import { TONE_STYLES } from "./StatTile";
import { CloudLogo, LlmLogo, VectorStoreLogo, llmProviderLabel } from "./ProviderLogo";

export default function ChatbotsTable({
  tenants,
  latestDeployByTenant,
}: {
  tenants: TenantRow[];
  latestDeployByTenant: Map<string, DeployJoinRow>;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b text-xs text-gray-500">
            <th className="px-4 py-2 font-medium">Chatbot</th>
            <th className="px-4 py-2 font-medium">Cloud &amp; Region</th>
            <th className="px-4 py-2 font-medium">LLM Provider</th>
            <th className="px-4 py-2 font-medium">Vector Store</th>
            <th className="px-4 py-2 font-medium">Status</th>
            <th className="px-4 py-2 font-medium">Last Deployment</th>
            <th className="px-4 py-2 font-medium">Est. Monthly Cost</th>
            <th className="px-4 py-2" />
          </tr>
        </thead>
        <tbody className="divide-y">
          {tenants.map((t) => {
            const latest = latestDeployByTenant.get(t.id)?.deployment;
            const status = t.deletedAt
              ? { label: "Deleted", tone: "gray" as const }
              : chatbotStatus(latest);
            const cost = estimateMonthlyCost(t.cloudProvider, t.vectorStore);
            const canOpen = !t.deletedAt && status.label === "Online" && t.chatbotUrl;

            return (
              <tr key={t.id}>
                <td className="px-4 py-3">
                  <div className="flex items-center gap-3">
                    <div
                      className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${TONE_STYLES[avatarTone(t.id)]}`}
                    >
                      {avatarInitials(t.name)}
                    </div>
                    <div>
                      <Link href={`/tenants/${t.id}`} className="font-medium text-gray-900 hover:text-blue-600 hover:underline">
                        {t.name}
                      </Link>
                      <div className="text-xs text-gray-500">{t.slug}</div>
                    </div>
                  </div>
                </td>
                <td className="px-4 py-3 text-xs text-gray-600">
                  <div className="flex items-center gap-2">
                    <CloudLogo provider={t.cloudProvider} />
                    {t.cloudProvider === "aws" ? (t.awsRegion ?? "—") : (t.azureRegion ?? "—")}
                  </div>
                </td>
                <td className="px-4 py-3 text-xs text-gray-600">
                  <div className="flex items-center gap-2">
                    <LlmLogo provider={t.llmProvider} />
                    <div>
                      <div className="font-medium text-gray-900">{llmProviderLabel(t.llmProvider)}</div>
                      {t.llmModel && <div className="text-gray-500">{t.llmModel}</div>}
                    </div>
                  </div>
                </td>
                <td className="px-4 py-3 text-xs text-gray-600">
                  <div className="flex items-center gap-2">
                    <VectorStoreLogo store={t.vectorStore} />
                    {t.vectorStore}
                  </div>
                </td>
                <td className="px-4 py-3">
                  <Badge label={status.label} tone={status.tone} />
                </td>
                <td className="px-4 py-3 text-xs text-gray-500">
                  {t.deletedAt
                    ? `deleted ${t.deletedAt.toLocaleString()}`
                    : (latest?.startedAt.toLocaleString() ?? "—")}
                </td>
                <td className="px-4 py-3 text-xs text-gray-600">
                  ${cost.totalLow}–${cost.totalHigh}
                </td>
                <td className="px-4 py-3 text-right">
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
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
