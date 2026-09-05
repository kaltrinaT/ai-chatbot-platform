"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { auth } from "@/auth";
import { db } from "@/db";
import { tenants } from "@/db/schema";
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
  azureTenantId: z.string().min(1, "Required"),
  azureClientId: z.string().min(1, "Required"),
  azureClientSecret: z.string().min(1, "Required"),
  azureRegion: z.string().min(1, "Required"),
});

// The Pinecone key is the customer's own, so it is mandatory when they pick
// Pinecone and unused when the vectors stay inside their cloud account.
const TenantInput = z
  .discriminatedUnion("cloudProvider", [AwsInput, AzureInput])
  .refine((v) => v.vectorStore !== "pinecone" || (v.pineconeApiKey ?? "").length >= 10, {
    message: "Required when the vector store is Pinecone",
    path: ["pineconeApiKey"],
  });

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
    llmModel: (formData.get("llmModel") as string) || undefined,
    vectorStore: formData.get("vectorStore") || "pinecone",
    pineconeApiKey: (formData.get("pineconeApiKey") as string) || undefined,
    // AWS
    awsAccountId: formData.get("awsAccountId"),
    awsRegion: formData.get("awsRegion"),
    deploymentRoleArn: formData.get("deploymentRoleArn"),
    s3DocsPrefix: (formData.get("s3DocsPrefix") as string) || undefined,
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

  await triggerDeployment({
    tenantId: tenant.id,
    chatbotVersion: parsed.chatbotVersion,
    triggeredByUserId: session.user.id,
  });

  redirect(`/tenants/${tenant.id}`);
}
