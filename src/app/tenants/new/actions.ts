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
  name: z.string().min(1).max(100),
  slug: z
    .string()
    .min(1)
    .max(40)
    .regex(/^[a-z0-9-]+$/, "lowercase letters, numbers, dashes only"),
  awsAccountId: z.string().regex(/^\d{12}$/, "must be a 12-digit AWS account ID"),
  awsRegion: z.string().min(1),
  deploymentRoleArn: z.string().regex(/^arn:aws:iam::\d{12}:role\/.+$/),
  chatbotVersion: z.string().min(1).default("latest"),
  domain: z.string().optional(),
  s3DocsBucket: z
    .string()
    .min(3)
    .max(63)
    .regex(/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/, "invalid S3 bucket name"),
  s3DocsPrefix: z.string().optional(),
  llmProvider: z.enum(["openai", "anthropic"]),
  llmApiKey: z.string().min(10, "API key looks too short"),
});

export async function createTenantAndDeploy(formData: FormData) {
  const session = await auth();
  if (!session?.user?.id) {
    redirect("/signin");
  }

  const parsed = TenantInput.parse({
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
