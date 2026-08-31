import {
  pgTable,
  text,
  timestamp,
  uuid,
  pgEnum,
  jsonb,
  integer,
  primaryKey,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import type { AdapterAccountType } from "next-auth/adapters";

export const deploymentStatusEnum = pgEnum("deployment_status", [
  "pending",
  "running",
  "succeeded",
  "failed",
  "cancelled",
]);

// "destroy" reuses the same table/status lifecycle/polling machinery as a
// normal deploy — see triggerTenantDestroy in src/lib/deploy.ts.
export const deploymentKindEnum = pgEnum("deployment_kind", ["deploy", "destroy"]);

export const llmProviderEnum = pgEnum("llm_provider", [
  "openai",
  "anthropic",
  "openrouter",
]);

export const cloudProviderEnum = pgEnum("cloud_provider", ["aws", "azure"]);

/**
 * Where the tenant's document embeddings live.
 *
 * "pinecone" — the customer's OWN Pinecone project (they supply the API key).
 * "pgvector" — Postgres + the pgvector extension provisioned inside the
 *              customer's own cloud account (RDS on AWS, Flexible Server on
 *              Azure), so no vector data leaves their subscription.
 */
export const vectorStoreEnum = pgEnum("vector_store", ["pinecone", "pgvector"]);

export const tenants = pgTable("tenants", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  ownerUserId: text("owner_user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),

  cloudProvider: cloudProviderEnum("cloud_provider").notNull().default("aws"),

  // ── AWS ──────────────────────────────────────────────────────────────
  awsAccountId: text("aws_account_id"),
  awsRegion: text("aws_region"),
  deploymentRoleArn: text("deployment_role_arn"),
  s3DocsBucket: text("s3_docs_bucket"),
  s3DocsPrefix: text("s3_docs_prefix"),
  // ARN in the tenant's own Secrets Manager holding the docs-signer shared
  // auth secret (written once during onboarding, like llmSecretArn) plus the
  // platform's own encrypted copy, used to call the Lambda directly without
  // ever touching tenant AWS credentials again after deploy.
  docsSignerSecretArn: text("docs_signer_secret_arn"),
  docsSignerSecretEncrypted: text("docs_signer_secret_encrypted"),
  docsSignerUrl: text("docs_signer_url"),

  // ── Azure ─────────────────────────────────────────────────────────────
  azureSubscriptionId: text("azure_subscription_id"),
  azureTenantId: text("azure_tenant_id"),
  azureClientId: text("azure_client_id"),
  azureClientSecretEncrypted: text("azure_client_secret_encrypted"),
  azureResourceGroup: text("azure_resource_group"),
  azureRegion: text("azure_region"),
  azureStorageAccount: text("azure_storage_account"),
  azureStorageContainer: text("azure_storage_container"),
  azureKeyVaultName: text("azure_key_vault_name"),

  // ── Shared ────────────────────────────────────────────────────────────
  llmProvider: llmProviderEnum("llm_provider").notNull(),
  llmApiKeyEncrypted: text("llm_api_key_encrypted").notNull(),
  llmSecretArn: text("llm_secret_arn"),
  llmModel: text("llm_model"),
  llmBaseUrl: text("llm_base_url"),

  // ── Vector store ──────────────────────────────────────────────────────
  vectorStore: vectorStoreEnum("vector_store").notNull().default("pinecone"),
  // Only set when vectorStore = "pinecone" — the CUSTOMER's own key.
  pineconeApiKeyEncrypted: text("pinecone_api_key_encrypted"),
  // AWS only: ARN of the customer-account secret holding the key above.
  // Mirrors llmSecretArn so the key never passes through GitHub Actions.
  pineconeSecretArn: text("pinecone_secret_arn"),

  domain: text("domain"),
  chatbotVersion: text("chatbot_version").notNull().default("latest"),

  albDnsName: text("alb_dns_name"),
  chatbotUrl: text("chatbot_url"),

  config: jsonb("config").$type<Record<string, unknown>>().default({}),

  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  // Soft delete — set once a "destroy" deployment succeeds. The row (and its
  // deployment/document history) stays for audit purposes but drops off the
  // active dashboard and can no longer be redeployed or managed.
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
});

export const deployments = pgTable("deployments", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),

  kind: deploymentKindEnum("kind").notNull().default("deploy"),
  status: deploymentStatusEnum("status").notNull().default("pending"),
  chatbotVersion: text("chatbot_version").notNull(),

  githubRunId: text("github_run_id"),
  githubRunUrl: text("github_run_url"),

  triggeredByUserId: text("triggered_by_user_id")
    .notNull()
    .references(() => users.id),

  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),

  errorMessage: text("error_message"),
});

/**
 * Status of a document as tracked by the platform's own record — the
 * platform never calls s3:ListBucket, so this table (not the bucket) is the
 * source of truth for "what documents exist" from the UI's perspective.
 */
export const documentStatusEnum = pgEnum("document_status", [
  "pending",
  "uploaded",
  "failed",
]);

export const tenantDocuments = pgTable("tenant_documents", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),

  // Minted server-side by the docs-signer Lambda — never client-supplied.
  objectKey: text("object_key").notNull(),
  displayName: text("display_name").notNull(),
  contentType: text("content_type").notNull(),
  sizeBytes: integer("size_bytes"),
  status: documentStatusEnum("status").notNull().default("pending"),

  uploadedByUserId: text("uploaded_by_user_id")
    .notNull()
    .references(() => users.id),

  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const users = pgTable("users", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  name: text("name"),
  email: text("email").unique(),
  emailVerified: timestamp("email_verified", { withTimezone: true }),
  image: text("image"),
});

export const accounts = pgTable(
  "accounts",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: text("type").$type<AdapterAccountType>().notNull(),
    provider: text("provider").notNull(),
    providerAccountId: text("provider_account_id").notNull(),
    refresh_token: text("refresh_token"),
    access_token: text("access_token"),
    expires_at: integer("expires_at"),
    token_type: text("token_type"),
    scope: text("scope"),
    id_token: text("id_token"),
    session_state: text("session_state"),
  },
  (account) => [primaryKey({ columns: [account.provider, account.providerAccountId] })],
);

export const sessions = pgTable("sessions", {
  sessionToken: text("session_token").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  expires: timestamp("expires", { withTimezone: true }).notNull(),
});

export const verificationTokens = pgTable(
  "verification_tokens",
  {
    identifier: text("identifier").notNull(),
    token: text("token").notNull(),
    expires: timestamp("expires", { withTimezone: true }).notNull(),
  },
  (vt) => [primaryKey({ columns: [vt.identifier, vt.token] })],
);

export const tenantsRelations = relations(tenants, ({ many, one }) => ({
  deployments: many(deployments),
  documents: many(tenantDocuments),
  owner: one(users, { fields: [tenants.ownerUserId], references: [users.id] }),
}));

export const deploymentsRelations = relations(deployments, ({ one }) => ({
  tenant: one(tenants, { fields: [deployments.tenantId], references: [tenants.id] }),
  triggeredBy: one(users, {
    fields: [deployments.triggeredByUserId],
    references: [users.id],
  }),
}));

export const tenantDocumentsRelations = relations(tenantDocuments, ({ one }) => ({
  tenant: one(tenants, { fields: [tenantDocuments.tenantId], references: [tenants.id] }),
  uploadedBy: one(users, {
    fields: [tenantDocuments.uploadedByUserId],
    references: [users.id],
  }),
}));
