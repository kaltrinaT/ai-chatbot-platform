import { NextResponse } from "next/server";
import { z } from "zod";
import { timingSafeEqual } from "crypto";
import { db } from "@/db";
import { deployments, tenants } from "@/db/schema";
import { eq } from "drizzle-orm";

const StatusUpdate = z.object({
  status: z.enum(["pending", "running", "succeeded", "failed", "cancelled"]),
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
    .where(eq(deployments.id, id))
    .returning();

  if (!updated) {
    return NextResponse.json({ error: "deployment not found" }, { status: 404 });
  }

  if (parsed.data.status === "succeeded" && updated.kind === "destroy") {
    await db
      .update(tenants)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
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
