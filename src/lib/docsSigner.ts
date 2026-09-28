import { decryptSecret } from "@/lib/crypto";
import type { tenants } from "@/db/schema";

type Tenant = typeof tenants.$inferSelect;

type SignerIdentity = Pick<Tenant, "cloudProvider" | "slug" | "awsRegion">;

/**
 * Why `url` cannot be this tenant's docs-signer, or null if it can.
 *
 * This URL is where the platform sends the tenant's docs-signer secret, so a
 * wrong value is not a broken link but a leaked credential: whoever it names
 * receives a secret that can write and delete the tenant's documents. It
 * arrives from the deploy workflow (the status webhook, or the outputs
 * artifact when that webhook is lost), and it is checked against what
 * Terraform actually builds before it is stored, and again before every use.
 *
 * - Azure: fully determined by the slug. The Function App is named
 *   chatbot-<slug>-docs-signer (infra/terraform/azure/main.tf), and outputs.tf
 *   builds the URL from its default hostname.
 * - AWS: a Lambda Function URL, https://<id>.lambda-url.<region>.on.aws/.
 *   The id is random, so only the shape and the tenant's own region can be
 *   checked here — anyone can create a Function URL of that shape in their
 *   own account. acceptDocsSignerUrl adds the rest: once recorded, the URL is
 *   never replaced by a callback.
 */
export function docsSignerUrlProblem(tenant: SignerIdentity, url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "not a valid URL";
  }
  if (parsed.protocol !== "https:") return "must use https";
  if (parsed.username || parsed.password || parsed.port || parsed.search || parsed.hash) {
    return "must not carry credentials, a port, a query or a fragment";
  }

  if (tenant.cloudProvider === "azure") {
    const expected = `https://chatbot-${tenant.slug}-docs-signer.azurewebsites.net/api/docs-signer`;
    return `${parsed.origin}${parsed.pathname}` === expected ? null : `expected ${expected}`;
  }

  if (!tenant.awsRegion) return "the tenant has no AWS region to check it against";
  const region = tenant.awsRegion.replace(/[^a-z0-9-]/g, "");
  const lambdaUrlHost = new RegExp(`^[a-z0-9]+\\.lambda-url\\.${region}\\.on\\.aws$`);
  if (!lambdaUrlHost.test(parsed.hostname) || parsed.pathname !== "/") {
    return `expected a Lambda Function URL in ${tenant.awsRegion} (https://<id>.lambda-url.${tenant.awsRegion}.on.aws/)`;
  }
  return null;
}

/**
 * Whether a docs-signer URL reported by a deploy run may be stored for this
 * tenant: it must look like the tenant's signer, and it must not replace one
 * already on record. Terraform keeps a Function URL for the life of the
 * function, so a redeploy reports the same value; a different one is refused
 * rather than trusted. That pin is what closes the AWS gap described above,
 * where the shape alone cannot tell the tenant's Lambda from someone else's.
 */
export function acceptDocsSignerUrl(
  tenant: SignerIdentity & Pick<Tenant, "docsSignerUrl">,
  url: string,
): string | null {
  const problem = docsSignerUrlProblem(tenant, url);
  if (problem) return problem;
  if (tenant.docsSignerUrl && tenant.docsSignerUrl !== url) {
    return "a different docs-signer URL is already on record for this tenant, and a deploy run cannot replace it";
  }
  return null;
}

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
type SignerTenant = SignerIdentity & Pick<Tenant, "docsSignerUrl" | "docsSignerSecretEncrypted">;

export async function callDocsSigner(
  tenant: SignerTenant,
  body: { action: "presign-upload"; fileName: string; contentType: string; sizeBytes: number }
    | { action: "delete"; objectKey: string },
): Promise<Record<string, unknown>> {
  if (!tenant.docsSignerUrl || !tenant.docsSignerSecretEncrypted) {
    throw new Error("Tenant has no docs-signer configured — deploy has not completed yet.");
  }

  // Checked again at the moment of use, so a value that reached the database
  // any other way — written before this check existed, or by hand — still
  // never receives the secret.
  const problem = docsSignerUrlProblem(tenant, tenant.docsSignerUrl);
  if (problem) {
    throw new Error(`Refusing to send the docs-signer secret to ${tenant.docsSignerUrl}: ${problem}`);
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
  tenant: SignerTenant,
  opts: { fileName: string; contentType: string; sizeBytes: number },
): Promise<PresignUploadResult> {
  const result = await callDocsSigner(tenant, { action: "presign-upload", ...opts });
  return result as unknown as PresignUploadResult;
}

export async function deleteViaSigner(
  tenant: SignerTenant,
  objectKey: string,
): Promise<void> {
  await callDocsSigner(tenant, { action: "delete", objectKey });
}
