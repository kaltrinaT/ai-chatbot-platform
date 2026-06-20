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

export const llmProviderEnum = pgEnum("llm_provider", [
  "openai",
  "anthropic",
]);

export const cloudProviderEnum = pgEnum("cloud_provider", ["aws", "azure"]);

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

  domain: text("domain"),
  chatbotVersion: text("chatbot_version").notNull().default("latest"),

  albDnsName: text("alb_dns_name"),
  chatbotUrl: text("chatbot_url"),

  config: jsonb("config").$type<Record<string, unknown>>().default({}),

  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const deployments = pgTable("deployments", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),

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
  owner: one(users, { fields: [tenants.ownerUserId], references: [users.id] }),
}));

export const deploymentsRelations = relations(deployments, ({ one }) => ({
  tenant: one(tenants, { fields: [deployments.tenantId], references: [tenants.id] }),
  triggeredBy: one(users, {
    fields: [deployments.triggeredByUserId],
    references: [users.id],
  }),
}));
