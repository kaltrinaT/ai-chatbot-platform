import { randomUUID } from "node:crypto";
import { redirect } from "next/navigation";
import Link from "next/link";
import { and, desc, eq } from "drizzle-orm";
import { auth } from "@/auth";
import { db } from "@/db";
import { tenantDrafts } from "@/db/schema";
import { findChatbotRepo } from "@/lib/github";
import DashboardShell from "@/app/(dashboard)/_components/DashboardShell";
import TenantForm from "./TenantForm";

export default async function NewTenantPage({
  searchParams,
}: {
  searchParams: Promise<{ draft?: string }>;
}) {
  const session = await auth();
  if (!session?.user?.id) redirect("/signin");

  // Only an explicitly-requested draft is resumed. Silently restoring the most
  // recent one would surprise someone who opened this page to start a new
  // chatbot and found a half-filled form for a different customer.
  const { draft: draftId } = await searchParams;
  const [draft] = draftId
    ? await db
        .select()
        .from(tenantDrafts)
        .where(and(eq(tenantDrafts.id, draftId), eq(tenantDrafts.ownerUserId, session.user.id)))
        .orderBy(desc(tenantDrafts.updatedAt))
        .limit(1)
    : [];

  return (
    <DashboardShell active="chatbots">
      <div className="mx-auto max-w-7xl px-6 py-8">
        <nav className="text-sm text-gray-500">
          <Link href="/chatbots" className="hover:underline">
            Chatbots
          </Link>
          <span className="mx-2 text-gray-300">/</span>
          <span className="text-gray-700">Create New Chatbot</span>
        </nav>

        <header className="mt-3 mb-8">
          <h1 className="text-3xl font-bold tracking-tight text-gray-900">Create New Chatbot</h1>
          <p className="mt-1 text-sm text-gray-500">
            Deploy a tenant-specific chatbot into a client-owned cloud environment.
          </p>
        </header>

        <TenantForm
          initialDraft={
            draft
              ? {
                  id: draft.id,
                  step: draft.step,
                  data: (draft.data ?? {}) as Record<string, string>,
                }
              : undefined
          }
          // Issued now rather than at insert, because an Azure customer has
          // to create a federated credential naming it before the first
          // deploy can log in. A resumed draft keeps the ID it was saved with.
          tenantId={randomUUID()}
          githubRepo={findChatbotRepo()}
          platformAccountId={process.env.PLATFORM_AWS_ACCOUNT_ID?.trim() || null}
          templateBaseUrl={process.env.PLATFORM_BOOTSTRAP_TEMPLATE_BASE_URL?.trim() || null}
        />
      </div>
    </DashboardShell>
  );
}
