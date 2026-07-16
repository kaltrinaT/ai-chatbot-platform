"use server";

import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
import { auth } from "@/auth";
import { db } from "@/db";
import { tenants } from "@/db/schema";
import { triggerDeployment } from "@/lib/deploy";

/**
 * Re-run the deploy for an existing tenant. This is an in-place update — it
 * triggers the same workflow + Terraform against the tenant's existing state,
 * so config/infra changes (e.g. a new LLM_MODEL default) get applied without
 * creating a second stack.
 */
export async function redeployTenant(formData: FormData) {
  const tenantId = String(formData.get("tenantId") ?? "");

  const session = await auth();
  if (!session?.user?.id) throw new Error("Not authenticated");

  const [tenant] = await db
    .select()
    .from(tenants)
    .where(and(eq(tenants.id, tenantId), eq(tenants.ownerUserId, session.user.id)));

  if (!tenant) throw new Error("Tenant not found");

  await triggerDeployment({
    tenantId: tenant.id,
    chatbotVersion: tenant.chatbotVersion,
    triggeredByUserId: session.user.id,
  });

  revalidatePath(`/tenants/${tenantId}`);
}
