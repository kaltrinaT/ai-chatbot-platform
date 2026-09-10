import { decryptSecret } from "@/lib/crypto";
import type { tenants } from "@/db/schema";

type Tenant = typeof tenants.$inferSelect;

/**
 * A non-2xx response from a tenant's docs-signer. Carries the status and body
 * separately so callers can turn them into something a tenant owner can act
 * on — the message alone is for logs. `message` is kept byte-identical to what
 * this used to throw as a plain Error.
 */
export class DocsSignerError extends Error {
  readonly status: number;
  readonly detail: string;

  constructor(status: number, detail: string) {
    super(`docs-signer returned ${status}${detail ? `: ${detail}` : ""}`);
    this.name = "DocsSignerError";
    this.status = status;
    this.detail = detail;
  }

  /**
   * The signer's own `error` string, unwrapped from the `{"error": "..."}`
   * body both the Lambda and the Azure Function reply with. Falls back to the
   * raw body for anything else (an API Gateway or Functions host error page,
   * say, which is not JSON at all).
   */
  get reason(): string {
    try {
      const parsed: unknown = JSON.parse(this.detail);
      if (parsed && typeof parsed === "object" && "error" in parsed) {
        const { error } = parsed as { error: unknown };
        if (typeof error === "string") return error;
      }
    } catch {
      // Not JSON — the raw body is the best available description.
    }
    return this.detail;
  }
}

export type PresignUploadResult = {
  objectKey: string;
  url: string;
  // Present for AWS (S3 presigned-POST — the browser builds a multipart
  // form from these). Absent for Azure (Blob SAS is a single URL the
  // browser PUTs to directly — see UploadDocumentForm.tsx).
  fields?: Record<string, string>;
};

/**
 * Calls the tenant's own docs-signer function (an AWS Lambda or an Azure
 * Function, depending on cloudProvider) over plain HTTPS. This is the ONLY
 * way the platform ever touches tenant documents — no AWS/Azure SDK, no
 * assumed role or service-principal credential capable of reading/writing
 * the bucket or container directly. Auth is a shared secret the platform
 * generated once (see ensureDocsSignerSecret in aws.ts / generateDocsSignerSecret
 * in azure.ts); the platform keeps its own encrypted copy so it never needs
 * to touch tenant cloud credentials again to use it.
 */
export async function callDocsSigner(
  tenant: Pick<Tenant, "docsSignerUrl" | "docsSignerSecretEncrypted">,
  body: { action: "presign-upload"; fileName: string; contentType: string; sizeBytes: number }
    | { action: "delete"; objectKey: string },
): Promise<Record<string, unknown>> {
  if (!tenant.docsSignerUrl || !tenant.docsSignerSecretEncrypted) {
    throw new Error("Tenant has no docs-signer configured — deploy has not completed yet.");
  }

  const secret = decryptSecret(tenant.docsSignerSecretEncrypted);

  const res = await fetch(tenant.docsSignerUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-docs-signer-secret": secret,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new DocsSignerError(res.status, detail);
  }

  return res.json();
}

export async function presignUpload(
  tenant: Pick<Tenant, "docsSignerUrl" | "docsSignerSecretEncrypted">,
  opts: { fileName: string; contentType: string; sizeBytes: number },
): Promise<PresignUploadResult> {
  const result = await callDocsSigner(tenant, { action: "presign-upload", ...opts });
  return result as unknown as PresignUploadResult;
}

export async function deleteViaSigner(
  tenant: Pick<Tenant, "docsSignerUrl" | "docsSignerSecretEncrypted">,
  objectKey: string,
): Promise<void> {
  await callDocsSigner(tenant, { action: "delete", objectKey });
}
