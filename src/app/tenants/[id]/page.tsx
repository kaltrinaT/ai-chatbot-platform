import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { auth } from "@/auth";
import { db } from "@/db";
import { tenants, deployments } from "@/db/schema";
import { and, eq, desc } from "drizzle-orm";

export default async function TenantDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await auth();
  if (!session?.user?.id) redirect("/signin");

  const { id } = await params;

  const [tenant] = await db
    .select()
    .from(tenants)
    .where(and(eq(tenants.id, id), eq(tenants.ownerUserId, session.user.id)));

  if (!tenant) notFound();

  const tenantDeploys = await db
    .select()
    .from(deployments)
    .where(eq(deployments.tenantId, tenant.id))
    .orderBy(desc(deployments.startedAt));

  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
      <Link href="/" className="text-sm text-gray-500 hover:underline">
        &larr; Back to dashboard
      </Link>

      <h1 className="mt-4 text-2xl font-semibold">{tenant.name}</h1>
      <p className="text-sm text-gray-500">{tenant.slug}</p>

      {tenant.chatbotUrl ? (
        <a
          href={tenant.chatbotUrl}
          target="_blank"
          rel="noreferrer"
          className="mt-6 block rounded border border-green-200 bg-green-50 p-4 text-sm hover:bg-green-100"
        >
          <div className="text-xs font-medium uppercase tracking-wide text-green-700">
            Chatbot live
          </div>
          <div className="mt-1 font-mono text-green-900">{tenant.chatbotUrl} ↗</div>
        </a>
      ) : (
        <div className="mt-6 rounded border border-dashed p-4 text-sm text-gray-500">
          Chatbot URL will appear here once the first deployment succeeds.
        </div>
      )}

      <dl className="mt-6 grid grid-cols-2 gap-x-6 gap-y-3 rounded border p-4 text-sm">
        <Row label="AWS account" value={tenant.awsAccountId} />
        <Row label="Region" value={tenant.awsRegion} />
        <Row label="Deployment role" value={tenant.deploymentRoleArn} mono />
        <Row label="S3 docs bucket" value={tenant.s3DocsBucket} />
        <Row label="S3 prefix" value={tenant.s3DocsPrefix ?? "—"} />
        <Row label="LLM provider" value={tenant.llmProvider} />
        <Row label="LLM secret ARN" value={tenant.llmSecretArn ?? "(pending)"} mono />
        <Row label="Chatbot version" value={tenant.chatbotVersion} />
        <Row label="Domain" value={tenant.domain ?? "—"} />
        <Row label="ALB DNS" value={tenant.albDnsName ?? "—"} mono />
        <Row label="Created" value={tenant.createdAt.toISOString()} />
      </dl>

      <h2 className="mt-8 mb-3 text-lg font-medium">Deployments</h2>
      {tenantDeploys.length === 0 ? (
        <p className="text-sm text-gray-500">No deployments yet.</p>
      ) : (
        <ul className="divide-y rounded border">
          {tenantDeploys.map((d) => (
            <li key={d.id} className="p-4 text-sm">
              <div className="flex items-center justify-between">
                <span className="font-mono text-xs text-gray-500">{d.id}</span>
                <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs">
                  {d.status}
                </span>
              </div>
              <div className="mt-1 text-xs text-gray-500">
                v{d.chatbotVersion} · started {d.startedAt.toISOString()}
                {d.finishedAt && ` · finished ${d.finishedAt.toISOString()}`}
              </div>
              {d.errorMessage && (
                <div className="mt-2 rounded bg-red-50 p-2 text-xs text-red-700">
                  {d.errorMessage}
                </div>
              )}
              {d.githubRunUrl && (
                <a
                  href={d.githubRunUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-2 inline-block text-xs text-blue-600 hover:underline"
                >
                  View GitHub Actions run &rarr;
                </a>
              )}
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <>
      <dt className="text-gray-500">{label}</dt>
      <dd className={mono ? "font-mono text-xs break-all" : ""}>{value}</dd>
    </>
  );
}
