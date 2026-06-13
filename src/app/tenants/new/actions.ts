"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { auth } from "@/auth";
import { db } from "@/db";
import { tenants } from "@/db/schema";
import { triggerDeployment } from "@/lib/deploy";
import { encryptSecret } from "@/lib/crypto";
import { assumeTenantRole, writeLlmSecret } from "@/lib/aws";
import { writeAzureKeyVaultSecret } from "@/lib/azure";

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
  llmProvider: z.enum(["openai", "anthropic"], {
    errorMap: () => ({ message: "Select a provider" }),
  }),
  llmApiKey: z.string().min(10, "API key looks too short"),
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
  s3DocsBucket: z
    .string()
    .min(3, "Must be at least 3 characters")
    .max(63, "Must be 63 characters or fewer")
    .regex(
      /^[a-z0-9][a-z0-9.-]*[a-z0-9]$/,
      "Lowercase letters, numbers, hyphens, and dots only"
    ),
  s3DocsPrefix: z
    .string()
    .refine((v) => !v.startsWith("/"), "Must not start with a leading slash")
    .optional(),
});

// ── Azure fields ──────────────────────────────────────────────────────
const AzureInput = SharedInput.extend({
  cloudProvider: z.literal("azure"),
  azureSubscriptionId: z
    .string()
    .regex(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      "Must be a valid UUID"
    ),
  azureTenantId: z
    .string()
    .regex(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      "Must be a valid UUID"
    ),
  azureClientId: z
    .string()
    .regex(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      "Must be a valid UUID"
    ),
  azureClientSecret: z.string().min(1, "Required"),
  azureResourceGroup: z.string().min(1, "Required").max(90),
  azureRegion: z.string().min(1, "Required"),
  azureStorageAccount: z
    .string()
    .min(3, "Must be at least 3 characters")
    .max(24, "Must be 24 characters or fewer")
    .regex(/^[a-z0-9]+$/, "Lowercase alphanumeric only"),
  azureStorageContainer: z.string().optional(),
  azureKeyVaultName: z
    .string()
    .min(3, "Must be at least 3 characters")
    .max(24, "Must be 24 characters or fewer")
    .regex(/^[a-zA-Z][a-zA-Z0-9-]*$/, "Must start with a letter, alphanumeric and hyphens only"),
});

const TenantInput = z.discriminatedUnion("cloudProvider", [AwsInput, AzureInput]);

export type FormState = { errors: Record<string, string> } | null;

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
    // AWS
    awsAccountId: formData.get("awsAccountId"),
    awsRegion: formData.get("awsRegion"),
    deploymentRoleArn: formData.get("deploymentRoleArn"),
    s3DocsBucket: formData.get("s3DocsBucket"),
    s3DocsPrefix: (formData.get("s3DocsPrefix") as string) || undefined,
    // Azure
    azureSubscriptionId: formData.get("azureSubscriptionId"),
    azureTenantId: formData.get("azureTenantId"),
    azureClientId: formData.get("azureClientId"),
    azureClientSecret: formData.get("azureClientSecret"),
    azureResourceGroup: formData.get("azureResourceGroup"),
    azureRegion: formData.get("azureRegion"),
    azureStorageAccount: formData.get("azureStorageAccount"),
    azureStorageContainer: (formData.get("azureStorageContainer") as string) || undefined,
    azureKeyVaultName: formData.get("azureKeyVaultName"),
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

  let llmSecretArn: string;
  let azureClientSecretEncrypted: string | undefined;

  if (parsed.cloudProvider === "aws") {
    const creds = await assumeTenantRole({
      roleArn: parsed.deploymentRoleArn,
      sessionName: `tenant-onboarding-${parsed.slug}`,
      region: parsed.awsRegion,
    });
    llmSecretArn = await writeLlmSecret({
      credentials: creds,
      region: parsed.awsRegion,
      secretName: `${parsed.slug}/llm-api-key`,
      secretValue: llmApiKey,
    });
  } else {
    azureClientSecretEncrypted = encryptSecret(parsed.azureClientSecret);
    llmSecretArn = await writeAzureKeyVaultSecret({
      credentials: {
        tenantId: parsed.azureTenantId,
        clientId: parsed.azureClientId,
        clientSecret: parsed.azureClientSecret,
        subscriptionId: parsed.azureSubscriptionId,
      },
      keyVaultName: parsed.azureKeyVaultName,
      secretName: "llm-api-key",
      secretValue: llmApiKey,
    });
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
          ownerUserId: session.user.id,
          awsAccountId: parsed.awsAccountId,
          awsRegion: parsed.awsRegion,
          deploymentRoleArn: parsed.deploymentRoleArn,
          s3DocsBucket: parsed.s3DocsBucket,
          s3DocsPrefix: parsed.s3DocsPrefix,
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
          ownerUserId: session.user.id,
          azureSubscriptionId: parsed.azureSubscriptionId,
          azureTenantId: parsed.azureTenantId,
          azureClientId: parsed.azureClientId,
          azureClientSecretEncrypted,
          azureResourceGroup: parsed.azureResourceGroup,
          azureRegion: parsed.azureRegion,
          azureStorageAccount: parsed.azureStorageAccount,
          azureStorageContainer: parsed.azureStorageContainer,
          azureKeyVaultName: parsed.azureKeyVaultName,
        };

  const [tenant] = await db.insert(tenants).values(insertValues).returning();

  await triggerDeployment({
    tenantId: tenant.id,
    chatbotVersion: parsed.chatbotVersion,
    triggeredByUserId: session.user.id,
  });

  redirect(`/tenants/${tenant.id}`);
}
