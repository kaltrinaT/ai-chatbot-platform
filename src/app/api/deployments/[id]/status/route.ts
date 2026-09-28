import { NextResponse } from "next/server";
import { z } from "zod";
import { timingSafeEqual } from "crypto";
import { db } from "@/db";
import { deployments, tenants } from "@/db/schema";
import { and, eq, inArray } from "drizzle-orm";
import { deletedTenantUpdate } from "@/lib/tenantErasure";
import { acceptDocsSignerUrl } from "@/lib/docsSigner";
import { ACTIVE_STATUSES } from "@/lib/reconcile";

const StatusUpdate = z.object({
  // No "pending": that is the state the platform creates a deployment in, and
  // nothing a run reports should ever move one back to it.
  status: z.enum(["running", "succeeded", "failed", "cancelled"]),
  githubRunId: z.string().optional(),
  githubRunUrl: z.string().url().optional(),
  errorMessage: z.string().optional(),
  albDnsName: z.string().optional(),
  chatbotUrl: z.string().url().optional(),
  docsSignerUrl: z.string().url().optional(),
  // Azure only — deterministic resource names Terraform assigns during
  // deploy, surfaced so the Infrastructure tab can show real values for
  // Azure tenants the same way it already does for AWS (s3DocsBucket etc.).
  azureResourceGroup: z.string().optional(),
  azureStorageAccount: z.string().optional(),
  azureStorageContainer: z.string().optional(),
  azureKeyVaultName: z.string().optional(),
});

function authorized(req: Request): boolean {
  const expected = process.env.DEPLOY_WEBHOOK_SECRET;
  if (!expected) return false;
  const header = req.headers.get("x-webhook-secret") ?? "";
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function isActive(status: string): boolean {
  return (ACTIVE_STATUSES as readonly string[]).includes(status);
}

/**
 * One shared secret authenticates every run's callbacks, so what a callback
 * may change is limited here rather than trusted:
 *
 * - A deployment only moves forward. Once it has finished, no callback can
 *   reopen or rewrite it — the same guard reconcile.ts applies, so a late or
 *   retried callback and a reconcile cannot overwrite each other either.
 * - A docs-signer URL must be this tenant's (see acceptDocsSignerUrl). The
 *   platform sends the tenant's docs-signer secret to that URL, so accepting
 *   any value would let whoever holds the webhook secret collect every
 *   tenant's docs-signer secret.
 *
 * Both are checked before anything is written, and a refusal says why, which
 * the workflow prints in its run log.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const body = await req.json().catch(() => null);
  const parsed = StatusUpdate.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const [row] = await db
    .select({ deployment: deployments, tenant: tenants })
    .from(deployments)
    .innerJoin(tenants, eq(deployments.tenantId, tenants.id))
    .where(eq(deployments.id, id));
  if (!row) {
    return NextResponse.json({ error: "deployment not found" }, { status: 404 });
  }
  const { deployment, tenant } = row;

  if (!isActive(deployment.status)) {
    return NextResponse.json(
      { error: `deployment already ${deployment.status}; a finished deployment cannot be changed` },
      { status: 409 },
    );
  }

  if (parsed.data.docsSignerUrl) {
    const problem = acceptDocsSignerUrl(tenant, parsed.data.docsSignerUrl);
    if (problem) {
      return NextResponse.json({ error: `docsSignerUrl refused: ${problem}` }, { status: 400 });
    }
  }

  const isTerminal = ["succeeded", "failed", "cancelled"].includes(parsed.data.status);

  const [updated] = await db
    .update(deployments)
    .set({
      status: parsed.data.status,
      githubRunId: parsed.data.githubRunId,
      githubRunUrl: parsed.data.githubRunUrl,
      errorMessage: parsed.data.errorMessage,
      ...(isTerminal ? { finishedAt: new Date() } : {}),
    })
    .where(and(eq(deployments.id, id), inArray(deployments.status, [...ACTIVE_STATUSES])))
    .returning();

  // Finished between the read above and this write — by a reconcile, or a
  // concurrent callback. Whichever landed first stands.
  if (!updated) {
    return NextResponse.json(
      { error: "deployment finished concurrently; this update was not applied" },
      { status: 409 },
    );
  }

  if (parsed.data.status === "succeeded" && updated.kind === "destroy") {
    await db
      .update(tenants)
      .set(deletedTenantUpdate())
      .where(eq(tenants.id, updated.tenantId));
  } else if (
    parsed.data.status === "succeeded" &&
    (parsed.data.albDnsName ||
      parsed.data.chatbotUrl ||
      parsed.data.docsSignerUrl ||
      parsed.data.azureResourceGroup ||
      parsed.data.azureStorageAccount ||
      parsed.data.azureStorageContainer ||
      parsed.data.azureKeyVaultName)
  ) {
    await db
      .update(tenants)
      .set({
        ...(parsed.data.albDnsName ? { albDnsName: parsed.data.albDnsName } : {}),
        ...(parsed.data.chatbotUrl ? { chatbotUrl: parsed.data.chatbotUrl } : {}),
        ...(parsed.data.docsSignerUrl ? { docsSignerUrl: parsed.data.docsSignerUrl } : {}),
        ...(parsed.data.azureResourceGroup ? { azureResourceGroup: parsed.data.azureResourceGroup } : {}),
        ...(parsed.data.azureStorageAccount ? { azureStorageAccount: parsed.data.azureStorageAccount } : {}),
        ...(parsed.data.azureStorageContainer
          ? { azureStorageContainer: parsed.data.azureStorageContainer }
          : {}),
        ...(parsed.data.azureKeyVaultName ? { azureKeyVaultName: parsed.data.azureKeyVaultName } : {}),
        updatedAt: new Date(),
      })
      .where(eq(tenants.id, updated.tenantId));
  }

  return NextResponse.json({ ok: true });
}
