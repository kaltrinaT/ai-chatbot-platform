"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { auth } from "@/auth";
import { db } from "@/db";
import { tenants, tenantDrafts } from "@/db/schema";
import { triggerDeployment } from "@/lib/deploy";
import { encryptSecret } from "@/lib/crypto";
import { assumeTenantRole, writeTenantSecret, ensureDocsSignerSecret } from "@/lib/aws";
import { generateDocsSignerSecret } from "@/lib/azure";

// ── Shared fields ─────────────────────────────────────────────────────
const SharedInput = z.object({
  cloudProvider: z.enum(["aws", "azure"]),
  name: z.string().min(1, "Required").max(100),
  slug: z
    .string()
    .min(3, "Must be at least 3 characters")
    .max(32, "Must be 32 characters or fewer")
    .regex(
      /^[a-z0-9][a-z0-9-]*[a-z0-9]$/,
      "Lowercase letters, numbers, and hyphens only; cannot start or end with a hyphen"
    ),
  chatbotVersion: z.string().min(1).default("latest"),
  domain: z
    .string()
    .refine(
      (v) => v === "" || /^([a-zA-Z0-9-]+\.)+[a-zA-Z]{2,}$/.test(v),
      "Must be a valid hostname (e.g. chat.example.com) — no https:// or trailing slash"
    )
    .optional(),
  llmProvider: z.enum(["openai", "anthropic", "openrouter"], {
    message: "Select a provider",
  }),
  llmApiKey: z.string().min(10, "API key looks too short"),
  llmModel: z.string().optional(),
  vectorStore: z.enum(["pinecone", "pgvector"]).default("pinecone"),
  // Required only for vectorStore = "pinecone"; enforced by the refine below.
  pineconeApiKey: z.string().optional(),

});


// ── AWS fields ────────────────────────────────────────────────────────
const AwsInput = SharedInput.extend({
  cloudProvider: z.literal("aws"),
  awsAccountId: z.string().regex(/^\d{12}$/, "Must be exactly 12 digits"),
  awsRegion: z
    .string()
    .regex(/^[a-z]{2}-[a-z]+-[0-9]$/, "Must be a valid AWS region (e.g. us-east-1)"),
  deploymentRoleArn: z
    .string()
    .regex(/^arn:aws:iam::\d{12}:role\/.+$/, "Must be a valid IAM role ARN"),
  s3DocsPrefix: z
    .string()
    .refine((v) => !v.startsWith("/"), "Must not start with a leading slash")
    .optional(),
  // Optional, but it is the only thing that gets a tenant TLS: without it the
  // ALB listens on port 80 only and every question and answer crosses the
  // internet in clear text.
  acmCertificateArn: z
    .string()
    .refine(
      (v) => v === "" || /^arn:aws:acm:[a-z0-9-]+:\d{12}:certificate\/.+$/.test(v),
      "Must be a valid ACM certificate ARN (arn:aws:acm:REGION:ACCOUNT:certificate/ID)",
    )
    .optional(),
});

// ── Azure fields ──────────────────────────────────────────────────────

// All three Azure identifiers are UUIDs, and the deploy's own Terraform
// validates them as such. Checking here too means a value pasted into the
// wrong box is rejected on the form, rather than surfacing minutes later as
// an opaque Entra error (AADSTS700016) from the middle of a workflow run.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const azureUuid = (label: string) =>
  z.string().regex(UUID_RE, `${label} must be a valid UUID`);

// The client secret is the one Azure field with no natural shape to validate,
// which is why the two easy portal mistakes both used to reach Entra and come
// back as an opaque AADSTS7000215 from the middle of a workflow run: pasting
// the Secret ID (a UUID, always visible) instead of the Value (shown once, at
// creation), or pasting an LLM key from the next step. Both are caught here.
// The trim matters too — a copied trailing space is invisible and rejected.
const azureClientSecret = z
  .string()
  .trim()
  .min(1, "Required")
  .refine((v) => !UUID_RE.test(v), {
    message:
      "That is the Secret ID. Copy the Value column instead — Azure shows it only once, when the secret is created.",
  })
  .refine((v) => !/^sk-/i.test(v), {
    message:
      "That looks like an LLM API key. This field wants the Azure service principal's client secret.",
  });

const AzureInput = SharedInput.extend({
  cloudProvider: z.literal("azure"),
  azureSubscriptionId: azureUuid("Subscription ID"),
  azureTenantId: azureUuid("Tenant ID"),
  azureClientId: azureUuid("Client ID"),
  azureClientSecret,
  azureRegion: z.string().min(1, "Required"),
});

// The Pinecone key is the customer's own, so it is mandatory when they pick
// Pinecone and unused when the vectors stay inside their cloud account.
const TenantInput = z
  .discriminatedUnion("cloudProvider", [AwsInput, AzureInput])
  .refine((v) => v.vectorStore !== "pinecone" || (v.pineconeApiKey ?? "").length >= 10, {
    message: "Required when the vector store is Pinecone",
    path: ["pineconeApiKey"],
  })
  // A certificate with no domain would open port 443 for a hostname nobody
  // resolves, while the tenant's advertised URL stayed on plain HTTP.
  .refine((v) => v.cloudProvider !== "aws" || !v.acmCertificateArn || Boolean(v.domain), {
    message:
      "A certificate only takes effect together with a custom domain. ACM cannot issue one for the load balancer's own hostname.",
    path: ["acmCertificateArn"],
  })
  // A load balancer can only use certificates from its own region. Caught
  // here because otherwise it surfaces minutes later, as a Terraform error
  // from the middle of a workflow run.
  .refine(
    (v) =>
      v.cloudProvider !== "aws" ||
      !v.acmCertificateArn ||
      v.acmCertificateArn.split(":")[3] === v.awsRegion,
    {
      message:
        "The certificate must live in the same region as the deployment. Request it again in the tenant's region.",
      path: ["acmCertificateArn"],
    },
  );

/**
 * `errors` is always present (empty on success) so callers can read it without
 * narrowing; `deployed` appears only once the tenant row exists and its first
 * deployment has been dispatched.
 *
 * The success path deliberately does NOT redirect: the wizard's final step
 * renders live deployment progress in place, so navigating away would drop the
 * user out of the flow the moment their deploy starts. The tenant page remains
 * reachable from that step (and is still where a returning user goes).
 */
export type FormState = {
  errors: Record<string, string>;
  deployed?: { tenantId: string; deploymentId: string; startedAt: string };
} | null;

/**
 * Everything after validation talks to the customer's cloud or to GitHub, and
 * any of it can fail for reasons no amount of form validation can predict: a
 * role that doesn't trust the platform, a secret still scheduled for deletion
 * from a torn-down tenant, a revoked PAT. Thrown, those reach the browser as
 * React's redacted placeholder and the wizard shows nothing but a 500.
 *
 * AWS and Azure SDK errors are surfaced verbatim. They describe the operator's
 * own account, using values they typed into this form a moment ago, and their
 * text ("...is not authorized to perform: sts:AssumeRole...") is the single
 * most useful thing we can put on screen. Anything unrecognised is not
 * forwarded and stays in the server log.
 */
function describeProvisioningFailure(err: unknown): string {
  if (typeof err === "object" && err !== null) {
    const e = err as { name?: string; message?: string; $metadata?: unknown };
    // $metadata is present on every AWS SDK v3 error.
    if (e.$metadata && e.message) {
      return e.name ? `${e.name}: ${e.message}` : e.message;
    }
    if (e.name === "HttpError" && e.message) {
      return `GitHub rejected the deployment dispatch: ${e.message}`;
    }
    // The platform's own AWS sign-in, rather than the customer's account: a
    // stored key it refuses, or a session that is missing or expired. Both are
    // fixed on the machine running the platform, so both say so.
    if (
      (e.name === "LongLivedAwsKeyError" || e.name === "PlatformCredentialsError") &&
      e.message
    ) {
      return e.message;
    }
    if (e.name === "CredentialsProviderError") {
      return (
        "The platform has no AWS credentials of its own. On a developer machine, " +
        "run aws login --profile platform-operator. On a hosted deployment, set " +
        "PLATFORM_AWS_ROLE_ARN and turn on the host's OIDC federation so it can " +
        "federate to that role instead."
      );
    }
    if (e.message?.includes("PLATFORM_ENCRYPTION_KEY")) {
      return e.message;
    }
  }
  return "Could not provision the tenant. The platform's server log has the reason.";
}

export async function createTenantAndDeploy(
  _prev: FormState,
  formData: FormData
): Promise<FormState> {
  const session = await auth();
  if (!session?.user?.id) redirect("/signin");

  const raw = {
    cloudProvider: formData.get("cloudProvider"),
    name: formData.get("name"),
    slug: formData.get("slug"),
    chatbotVersion: formData.get("chatbotVersion") || "latest",
    domain: (formData.get("domain") as string) || undefined,
    llmProvider: formData.get("llmProvider"),
    llmApiKey: formData.get("llmApiKey"),
    llmModel: (formData.get("llmModel") as string) || undefined,
    vectorStore: formData.get("vectorStore") || "pinecone",
    pineconeApiKey: (formData.get("pineconeApiKey") as string) || undefined,
    // AWS
    awsAccountId: formData.get("awsAccountId"),
    awsRegion: formData.get("awsRegion"),
    deploymentRoleArn: formData.get("deploymentRoleArn"),
    s3DocsPrefix: (formData.get("s3DocsPrefix") as string) || undefined,
    acmCertificateArn: (formData.get("acmCertificateArn") as string) || undefined,
    // Azure
    azureSubscriptionId: formData.get("azureSubscriptionId"),
    azureTenantId: formData.get("azureTenantId"),
    azureClientId: formData.get("azureClientId"),
    azureClientSecret: formData.get("azureClientSecret"),
    azureRegion: formData.get("azureRegion"),
  };

  const result = TenantInput.safeParse(raw);

  if (!result.success) {
    const errors: Record<string, string> = {};
    for (const issue of result.error.issues) {
      const field = String(issue.path[issue.path.length - 1]);
      if (!errors[field]) errors[field] = issue.message;
    }
    return { errors };
  }

  const parsed = result.data;
  const { llmApiKey, ...tenantFields } = parsed;
  const llmApiKeyEncrypted = encryptSecret(llmApiKey);

  const usesPinecone = parsed.vectorStore === "pinecone";
  const pineconeApiKeyEncrypted = usesPinecone
    ? encryptSecret(parsed.pineconeApiKey!)
    : null;

  let llmSecretArn: string | null;
  let pineconeSecretArn: string | null = null;
  let azureClientSecretEncrypted: string | undefined;
  let docsSignerSecretArn: string | null = null;
  let docsSignerSecretEncrypted: string | null = null;

  try {
    if (parsed.cloudProvider === "aws") {
      const creds = await assumeTenantRole({
        roleArn: parsed.deploymentRoleArn,
        sessionName: `tenant-onboarding-${parsed.slug}`,
        region: parsed.awsRegion,
      });
      llmSecretArn = await writeTenantSecret({
        credentials: creds,
        region: parsed.awsRegion,
        secretName: `${parsed.slug}/llm-api-key`,
        secretValue: llmApiKey,
        description:
          "LLM API key for the AI chatbot tenant (managed by ai-chatbot-platform)",
      });
      if (usesPinecone) {
        pineconeSecretArn = await writeTenantSecret({
          credentials: creds,
          region: parsed.awsRegion,
          secretName: `${parsed.slug}/pinecone-api-key`,
          secretValue: parsed.pineconeApiKey!,
          description:
            "Customer-owned Pinecone API key for the AI chatbot tenant (managed by ai-chatbot-platform)",
        });
      }
      const docsSigner = await ensureDocsSignerSecret({
        roleArn: parsed.deploymentRoleArn,
        region: parsed.awsRegion,
        slug: parsed.slug,
        sessionName: `tenant-onboarding-docs-${parsed.slug}`,
      });
      docsSignerSecretArn = docsSigner.docsSignerSecretArn;
      docsSignerSecretEncrypted = docsSigner.docsSignerSecretEncrypted;
    } else {
      azureClientSecretEncrypted = encryptSecret(parsed.azureClientSecret);
      // LLM key is passed directly to the workflow from the encrypted DB value;
      // Terraform creates the Key Vault and stores it there during deploy.
      llmSecretArn = null;
      docsSignerSecretEncrypted = generateDocsSignerSecret().docsSignerSecretEncrypted;
    }

    const insertValues =
      parsed.cloudProvider === "aws"
        ? {
            cloudProvider: "aws" as const,
            name: tenantFields.name,
            slug: tenantFields.slug,
            chatbotVersion: tenantFields.chatbotVersion,
            domain: tenantFields.domain,
            llmProvider: tenantFields.llmProvider,
            llmApiKeyEncrypted,
            llmSecretArn,
            llmModel: tenantFields.llmModel ?? null,
            vectorStore: parsed.vectorStore,
            pineconeApiKeyEncrypted,
            pineconeSecretArn,
            ownerUserId: session.user.id,
            awsAccountId: parsed.awsAccountId,
            awsRegion: parsed.awsRegion,
            deploymentRoleArn: parsed.deploymentRoleArn,
            s3DocsPrefix: parsed.s3DocsPrefix,
            acmCertificateArn: parsed.acmCertificateArn || null,
            docsSignerSecretArn,
            docsSignerSecretEncrypted,
          }
        : {
            cloudProvider: "azure" as const,
            name: tenantFields.name,
            slug: tenantFields.slug,
            chatbotVersion: tenantFields.chatbotVersion,
            domain: tenantFields.domain,
            llmProvider: tenantFields.llmProvider,
            llmApiKeyEncrypted,
            llmSecretArn,
            llmModel: tenantFields.llmModel ?? null,
            vectorStore: parsed.vectorStore,
            pineconeApiKeyEncrypted,
            ownerUserId: session.user.id,
            azureSubscriptionId: parsed.azureSubscriptionId,
            azureTenantId: parsed.azureTenantId,
            azureClientId: parsed.azureClientId,
            azureClientSecretEncrypted,
            azureRegion: parsed.azureRegion,
            docsSignerSecretEncrypted,
          };

    const [tenant] = await db.insert(tenants).values(insertValues).returning();

    const deployment = await triggerDeployment({
      tenantId: tenant.id,
      chatbotVersion: parsed.chatbotVersion,
      triggeredByUserId: session.user.id,
    });

    // The wizard was saved as a draft while it was being filled in; the tenant
    // it was a draft OF now exists, so the draft has served its purpose.
    const draftId = formData.get("draftId");
    if (typeof draftId === "string" && draftId) {
      await db
        .delete(tenantDrafts)
        .where(and(eq(tenantDrafts.id, draftId), eq(tenantDrafts.ownerUserId, session.user.id)));
    }

    return {
      errors: {},
      deployed: {
        tenantId: tenant.id,
        deploymentId: deployment.id,
        startedAt: deployment.startedAt.toISOString(),
      },
    };
  } catch (err) {
    // The only place the real cause is recorded — the caller gets a summary.
    console.error(
      `[createTenantAndDeploy] provisioning failed for ${parsed.cloudProvider} tenant ` +
        `'${parsed.slug}' (owner ${session.user.id})`,
      err,
    );
    return { errors: { _form: describeProvisioningFailure(err) } };
  }
}

// Wizard fields that are customer credentials. Stripped before a draft is
// persisted: a draft is an unfinished form with no deployment behind it, and
// storing plaintext keys in the control plane for it would undercut the whole
// "secrets live in the customer's cloud" property. Re-entered on resume.
const DRAFT_SECRET_FIELDS = ["llmApiKey", "pineconeApiKey", "azureClientSecret"] as const;

export type DraftState = { draftId: string; savedAt: string } | { error: string } | null;

/**
 * Upserts the wizard's non-secret state. Called by "Save Draft" rather than on
 * every keystroke, so it is a normal action and not debounced server chatter.
 */
export async function saveTenantDraft(
  _prev: DraftState,
  formData: FormData
): Promise<DraftState> {
  const session = await auth();
  if (!session?.user?.id) redirect("/signin");

  const data: Record<string, unknown> = {};
  for (const [key, value] of formData.entries()) {
    if (typeof value !== "string") continue;
    if ((DRAFT_SECRET_FIELDS as readonly string[]).includes(key)) continue;
    if (key === "draftId" || key === "step") continue;
    if (value === "") continue;
    data[key] = value;
  }

  const rawStep = Number(formData.get("step"));
  const step = Number.isInteger(rawStep) && rawStep >= 1 && rawStep <= 5 ? rawStep : 1;
  const name = typeof data.name === "string" ? data.name : null;
  const existingId = formData.get("draftId");

  try {
    if (typeof existingId === "string" && existingId) {
      const [updated] = await db
        .update(tenantDrafts)
        .set({ data, step, name, updatedAt: new Date() })
        .where(
          and(eq(tenantDrafts.id, existingId), eq(tenantDrafts.ownerUserId, session.user.id))
        )
        .returning();
      // Falls through to an insert when the id doesn't belong to this user or
      // no longer exists, rather than silently reporting a save that didn't
      // happen.
      if (updated) {
        return { draftId: updated.id, savedAt: updated.updatedAt.toISOString() };
      }
    }

    const [created] = await db
      .insert(tenantDrafts)
      .values({ ownerUserId: session.user.id, data, step, name })
      .returning();
    return { draftId: created.id, savedAt: created.updatedAt.toISOString() };
  } catch {
    return { error: "Could not save the draft. Your entries are still on this page." };
  }
}

export async function deleteTenantDraft(draftId: string): Promise<void> {
  const session = await auth();
  if (!session?.user?.id) redirect("/signin");

  await db
    .delete(tenantDrafts)
    .where(and(eq(tenantDrafts.id, draftId), eq(tenantDrafts.ownerUserId, session.user.id)));

  // The drafts list on /chatbots is the only place a draft is reachable from,
  // so it has to reflect the deletion immediately.
  revalidatePath("/chatbots");
}
