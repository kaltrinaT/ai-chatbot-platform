"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { auth } from "@/auth";
import { db } from "@/db";
import { tenants } from "@/db/schema";
import { triggerDeployment } from "@/lib/deploy";
import { encryptSecret } from "@/lib/crypto";
import { assumeTenantRole, writeLlmSecret } from "@/lib/aws";

const TenantInput = z.object({
  name: z.string().min(1, "Required").max(100),
  slug: z
    .string()
    .min(3, "Must be at least 3 characters")
    .max(32, "Must be 32 characters or fewer")
    .regex(
      /^[a-z0-9][a-z0-9-]*[a-z0-9]$/,
      "Lowercase letters, numbers, and hyphens only; cannot start or end with a hyphen"
    ),
  awsAccountId: z
    .string()
    .regex(/^\d{12}$/, "Must be exactly 12 digits"),
  awsRegion: z
    .string()
    .regex(/^[a-z]{2}-[a-z]+-[0-9]$/, "Must be a valid AWS region (e.g. us-east-1)"),
  deploymentRoleArn: z
    .string()
    .regex(/^arn:aws:iam::\d{12}:role\/.+$/, "Must be a valid IAM role ARN"),
  chatbotVersion: z.string().min(1).default("latest"),
  domain: z
    .string()
    .refine(
      (v) => v === "" || /^([a-zA-Z0-9-]+\.)+[a-zA-Z]{2,}$/.test(v),
      "Must be a valid hostname (e.g. chat.example.com) — no https:// or trailing slash"
    )
    .optional(),
  s3DocsBucket: z
    .string()
    .min(3, "Must be at least 3 characters")
    .max(63, "Must be 63 characters or fewer")
    .regex(
      /^[a-z0-9][a-z0-9.-]*[a-z0-9]$/,
      "Lowercase letters, numbers, hyphens, and dots only; cannot start or end with a dot or hyphen"
    ),
  s3DocsPrefix: z
    .string()
    .refine((v) => !v.startsWith("/"), "Must not start with a leading slash")
    .optional(),
  llmProvider: z.enum(["openai", "anthropic"], {
    errorMap: () => ({ message: "Select a provider" }),
  }),
  llmApiKey: z.string().min(10, "API key looks too short"),
});

export type FormState = {
  errors: Record<string, string>;
} | null;

export async function createTenantAndDeploy(
  _prev: FormState,
  formData: FormData
): Promise<FormState> {
  const session = await auth();
  if (!session?.user?.id) redirect("/signin");

  const result = TenantInput.safeParse({
    name: formData.get("name"),
    slug: formData.get("slug"),
    awsAccountId: formData.get("awsAccountId"),
    awsRegion: formData.get("awsRegion"),
    deploymentRoleArn: formData.get("deploymentRoleArn"),
    chatbotVersion: formData.get("chatbotVersion") || "latest",
    domain: (formData.get("domain") as string) || undefined,
    s3DocsBucket: formData.get("s3DocsBucket"),
    s3DocsPrefix: (formData.get("s3DocsPrefix") as string) || undefined,
    llmProvider: formData.get("llmProvider"),
    llmApiKey: formData.get("llmApiKey"),
  });

  if (!result.success) {
    const errors: Record<string, string> = {};
    for (const issue of result.error.issues) {
      const field = String(issue.path[0]);
      if (!errors[field]) errors[field] = issue.message;
    }
    return { errors };
  }

  const parsed = result.data;
  const { llmApiKey, ...tenantFields } = parsed;
  const llmApiKeyEncrypted = encryptSecret(llmApiKey);

  const creds = await assumeTenantRole({
    roleArn: parsed.deploymentRoleArn,
    sessionName: `tenant-onboarding-${parsed.slug}`,
    region: parsed.awsRegion,
  });

  const llmSecretArn = await writeLlmSecret({
    credentials: creds,
    region: parsed.awsRegion,
    secretName: `${parsed.slug}/llm-api-key`,
    secretValue: llmApiKey,
  });

  const [tenant] = await db
    .insert(tenants)
    .values({
      ...tenantFields,
      llmApiKeyEncrypted,
      llmSecretArn,
      ownerUserId: session.user.id,
    })
    .returning();

  await triggerDeployment({
    tenantId: tenant.id,
    chatbotVersion: parsed.chatbotVersion,
    triggeredByUserId: session.user.id,
  });

  redirect(`/tenants/${tenant.id}`);
}
