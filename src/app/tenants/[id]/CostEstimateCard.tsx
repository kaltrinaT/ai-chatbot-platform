import {
  estimateMonthlyCost,
  COST_FOOTNOTES,
  AZURE_FREE_GRANT_NOTE,
} from "@/lib/pricing";

function usd(n: number): string {
  return n < 1 ? `$${n.toFixed(2)}` : `$${Math.round(n)}`;
}

function range(low: number, high: number): string {
  return low === high ? usd(low) : `${usd(low)}–${usd(high).slice(1)}`;
}

export default function CostEstimateCard({
  provider,
  slug,
}: {
  provider: "aws" | "azure";
  slug: string;
}) {
  const est = estimateMonthlyCost(provider);
  const footnotes =
    provider === "azure" ? [...COST_FOOTNOTES, AZURE_FREE_GRANT_NOTE] : COST_FOOTNOTES;

  return (
    <section className="mt-6 rounded border p-4 text-sm">
      <div className="flex items-baseline justify-between">
        <h2 className="font-medium">Estimated monthly infrastructure cost</h2>
        <span className="text-lg font-semibold">
          {range(est.totalLow, est.totalHigh)}
          <span className="ml-1 text-xs font-normal text-gray-500">/ month</span>
        </span>
      </div>
      <p className="mt-1 text-xs text-gray-500">
        Billed to the customer&apos;s {provider === "azure" ? "Azure subscription" : "AWS account"} —
        the platform charges nothing per tenant.
      </p>

      <ul className="mt-3 divide-y">
        {est.lines.map((l) => (
          <li key={l.label} className="flex items-center justify-between py-1.5">
            <div>
              <span>{l.label}</span>
              <span className="ml-2 text-xs text-gray-500">{l.detail}</span>
            </div>
            <span className="font-mono text-xs">{range(l.lowUsd, l.highUsd)}</span>
          </li>
        ))}
      </ul>

      <div className="mt-3 rounded bg-gray-50 p-3 text-xs text-gray-600">
        <div className="font-medium text-gray-700">Track actual costs</div>
        {provider === "aws" ? (
          <p className="mt-1">
            Every resource is tagged <code className="font-mono">Tenant = {slug}</code>. In the
            customer&apos;s account, activate this tag under Billing → Cost allocation tags (takes
            ~24h to appear), then filter Cost Explorer by it for exact per-tenant spend.
          </p>
        ) : (
          <p className="mt-1">
            Every resource is tagged <code className="font-mono">Tenant = {slug}</code>. In the
            customer&apos;s subscription, open Cost Management → Cost analysis and group or filter
            by that tag for exact per-tenant spend.
          </p>
        )}
      </div>

      <ul className="mt-3 space-y-1 text-xs text-gray-500">
        {footnotes.map((f) => (
          <li key={f}>• {f}</li>
        ))}
      </ul>
    </section>
  );
}
