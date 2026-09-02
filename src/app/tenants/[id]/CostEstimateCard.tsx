import {
  estimateMonthlyCost,
  costFootnotes,
  AZURE_FREE_GRANT_NOTE,
  type VectorStore,
} from "@/lib/pricing";

function usd(n: number): string {
  return n < 1 ? `$${n.toFixed(2)}` : `$${Math.round(n)}`;
}

function range(low: number, high: number): string {
  return low === high ? usd(low) : `${usd(low)}–${usd(high).slice(1)}`;
}

const PROVIDER_STYLE = {
  aws: {
    accountLabel: "AWS account",
    accent: "text-orange-700",
    badgeBg: "bg-orange-50",
    badgeBorder: "border-orange-200",
    bar: "bg-orange-400",
  },
  azure: {
    accountLabel: "Azure subscription",
    accent: "text-sky-700",
    badgeBg: "bg-sky-50",
    badgeBorder: "border-sky-200",
    bar: "bg-sky-400",
  },
} as const;

export default function CostEstimateCard({
  provider,
  slug,
  vectorStore = "pinecone",
}: {
  provider: "aws" | "azure";
  slug: string;
  vectorStore?: VectorStore;
}) {
  const est = estimateMonthlyCost(provider, vectorStore);
  const base = costFootnotes(vectorStore);
  const footnotes = provider === "azure" ? [...base, AZURE_FREE_GRANT_NOTE] : base;
  const style = PROVIDER_STYLE[provider];
  const maxMid = Math.max(...est.lines.map((l) => (l.lowUsd + l.highUsd) / 2), 1);

  return (
    <section className="rounded-xl border p-5 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-gray-900">
            Estimated monthly infrastructure cost
          </h2>
          <p className="mt-1 text-xs text-gray-500">
            Billed to the customer&apos;s {style.accountLabel} — the platform charges nothing per
            tenant.
          </p>
        </div>
        <div
          className={`rounded-lg border ${style.badgeBorder} ${style.badgeBg} px-3.5 py-2 text-right`}
        >
          <div className={`text-xl font-bold leading-none ${style.accent}`}>
            {range(est.totalLow, est.totalHigh)}
          </div>
          <div className="mt-1 text-[11px] font-medium uppercase tracking-wide text-gray-400">
            per month
          </div>
        </div>
      </div>

      <ul className="mt-5 divide-y">
        {est.lines.map((l) => {
          const mid = (l.lowUsd + l.highUsd) / 2;
          const pct = Math.max((mid / maxMid) * 100, 3);
          return (
            <li key={l.label} className="py-2.5 first:pt-0 last:pb-0">
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-sm font-medium text-gray-800">{l.label}</span>
                <span className="shrink-0 font-mono text-sm text-gray-700">
                  {range(l.lowUsd, l.highUsd)}
                </span>
              </div>
              <div className="mt-0.5 text-xs text-gray-500">{l.detail}</div>
              <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-gray-100">
                <div className={`h-full rounded-full ${style.bar}`} style={{ width: `${pct}%` }} />
              </div>
            </li>
          );
        })}
      </ul>

      <div className="mt-5 flex items-start gap-3 rounded-lg bg-blue-50 p-3.5 text-xs text-blue-900">
        <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-blue-100 text-sm font-semibold text-blue-600">
          $
        </span>
        <div>
          <div className="font-semibold text-blue-800">Track actual costs</div>
          {provider === "aws" ? (
            <p className="mt-1 leading-relaxed">
              Every resource is tagged{" "}
              <code className="rounded bg-white/70 px-1 font-mono">Tenant = {slug}</code>. In the
              customer&apos;s account, activate this tag under Billing → Cost allocation tags
              (takes ~24h to appear), then filter Cost Explorer by it for exact per-tenant spend.
            </p>
          ) : (
            <p className="mt-1 leading-relaxed">
              Every resource is tagged{" "}
              <code className="rounded bg-white/70 px-1 font-mono">Tenant = {slug}</code>. In the
              customer&apos;s subscription, open Cost Management → Cost analysis and group or
              filter by that tag for exact per-tenant spend.
            </p>
          )}
        </div>
      </div>

      <details className="mt-4 text-xs text-gray-500">
        <summary className="cursor-pointer select-none font-medium text-gray-600 hover:text-gray-800">
          Estimate notes
        </summary>
        <ul className="mt-2 space-y-1.5 pl-0.5">
          {footnotes.map((f) => (
            <li key={f} className="flex gap-1.5">
              <span className="text-gray-300">•</span>
              <span className="leading-relaxed">{f}</span>
            </li>
          ))}
        </ul>
      </details>
    </section>
  );
}
