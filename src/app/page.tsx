import Link from "next/link";
import { redirect } from "next/navigation";
import { auth, signOut } from "@/auth";
import { db } from "@/db";
import { tenants, deployments } from "@/db/schema";
import { eq, desc } from "drizzle-orm";

export default async function DashboardPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/signin");

  const myTenants = await db
    .select()
    .from(tenants)
    .where(eq(tenants.ownerUserId, session.user.id))
    .orderBy(desc(tenants.createdAt));

  const recentDeploys = myTenants.length
    ? await db
        .select()
        .from(deployments)
        .orderBy(desc(deployments.startedAt))
        .limit(10)
    : [];

  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      <header className="flex items-center justify-between border-b pb-4 mb-8">
        <div>
          <h1 className="text-2xl font-semibold">AI Chatbot Platform</h1>
          <p className="text-sm text-gray-500">
            Signed in as {session.user.email}
          </p>
        </div>
        <div className="flex gap-3">
          {process.env.DEMO_CHATBOT_URL && (
            <a
              href={process.env.DEMO_CHATBOT_URL}
              target="_blank"
              rel="noreferrer"
              className="rounded-md border border-indigo-200 bg-indigo-50 px-4 py-2 text-sm font-medium text-indigo-700 hover:bg-indigo-100"
            >
              Demo chatbot ↗
            </a>
          )}
          <Link
            href="/tenants/new"
            className="rounded-md bg-black px-4 py-2 text-sm font-medium text-white hover:bg-gray-800"
          >
            Deploy new tenant
          </Link>
          <form
            action={async () => {
              "use server";
              await signOut({ redirectTo: "/signin" });
            }}
          >
            <button
              type="submit"
              className="rounded-md border px-4 py-2 text-sm font-medium hover:bg-gray-50"
            >
              Sign out
            </button>
          </form>
        </div>
      </header>

      <section className="mb-10">
        <h2 className="mb-3 text-lg font-medium">Your tenants</h2>
        {myTenants.length === 0 ? (
          <p className="rounded border border-dashed p-6 text-sm text-gray-500">
            No tenants yet. Click <span className="font-medium">Deploy new tenant</span> to provision a chatbot stack into a customer AWS account.
          </p>
        ) : (
          <ul className="divide-y rounded border">
            {myTenants.map((t: typeof tenants.$inferSelect) => (
              <li key={t.id} className="flex items-center justify-between p-4">
                <div>
                  <div className="font-medium">{t.name}</div>
                  <div className="text-xs text-gray-500">
                    {t.slug} · AWS {t.awsAccountId} · {t.awsRegion} · v{t.chatbotVersion}
                  </div>
                </div>
                <Link
                  href={`/tenants/${t.id}`}
                  className="text-sm text-blue-600 hover:underline"
                >
                  View
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2 className="mb-3 text-lg font-medium">Recent deployments</h2>
        {recentDeploys.length === 0 ? (
          <p className="text-sm text-gray-500">No deployments yet.</p>
        ) : (
          <ul className="divide-y rounded border">
            {recentDeploys.map((d: typeof deployments.$inferSelect) => (
              <li key={d.id} className="flex items-center justify-between p-4 text-sm">
                <div>
                  <span className="font-mono text-xs text-gray-500">{d.id.slice(0, 8)}</span>
                  <span className="ml-3">v{d.chatbotVersion}</span>
                </div>
                <div className="flex items-center gap-4">
                  <StatusPill status={d.status} />
                  {d.githubRunUrl && (
                    <a
                      href={d.githubRunUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="text-blue-600 hover:underline"
                    >
                      Logs
                    </a>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}

function StatusPill({ status }: { status: string }) {
  const styles: Record<string, string> = {
    pending: "bg-gray-100 text-gray-700",
    running: "bg-blue-100 text-blue-700",
    succeeded: "bg-green-100 text-green-700",
    failed: "bg-red-100 text-red-700",
    cancelled: "bg-yellow-100 text-yellow-800",
  };
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs ${styles[status] ?? styles.pending}`}>
      {status}
    </span>
  );
}
