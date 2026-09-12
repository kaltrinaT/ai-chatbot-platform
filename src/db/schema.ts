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
  // ARN of an ACM certificate covering `domain`, in the tenant's own region.
  // Null means the ALB has no HTTPS listener and chat traffic is unencrypted
  // — which was the only possible state before this column existed. The
  // customer issues and validates the certificate themselves: ACM will not
  // issue for the ALB's own *.elb.amazonaws.com name, so this is always
  // accompanied by `domain`.
  acmCertificateArn: text("acm_certificate_arn"),
  // Shared by both clouds, populated asymmetrically:
  //  - AWS: docsSignerSecretArn is the ARN of the secret written once into
  //    the tenant's own Secrets Manager during onboarding (like
  //    llmSecretArn) — only the ARN needs to travel through Terraform
  //    afterward.
  //  - Azure: docsSignerSecretArn stays null. The tenant's Key Vault doesn't
  //    exist until Terraform creates it during deploy, so there is nothing
  //    to write to (or reference by ARN) at onboarding time — see
  //    generateDocsSignerSecret in azure.ts. The plaintext is instead
  //    re-decrypted and resent as a masked deploy input on every deploy.
  //  - Both clouds: docsSignerSecretEncrypted is the platform's own
  //    AES-256-GCM copy, used to call the docs-signer function (Lambda or
  //    Azure Function) directly without ever touching tenant cloud
  //    credentials again. docsSignerUrl is the function's invoke URL,
  //    populated by the same deployment-status webhook field either way.
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

/**
 * A partially-completed onboarding wizard, saved by "Save Draft".
 *
 * Deliberately NOT a `tenants` row with nullable columns: a draft has no
 * cloud resources, must never be deployable, and would otherwise have to
 * relax the notNull constraints that keep a real tenant well-formed.
 *
 * `data` holds only NON-SECRET wizard fields. The LLM key, Pinecone key and
 * Azure client secret are stripped before saving (see DRAFT_SECRET_FIELDS in
 * the wizard's actions) and must be re-entered when the draft is resumed.
 * Persisting them would put plaintext customer credentials in the control
 * plane's own database for an object with no deployment behind it yet —
 * exactly the thing the "secrets live in the customer's cloud" design avoids.
 */
export const tenantDrafts = pgTable("tenant_drafts", {
  id: uuid("id").defaultRandom().primaryKey(),
  ownerUserId: text("owner_user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),

  // Mirrors the wizard's "Chatbot Name" when set, so the drafts list can show
  // something recognisable before the tenant exists.
  name: text("name"),
  data: jsonb("data").$type<Record<string, unknown>>().notNull().default({}),
  // Which wizard step the user left off on, so resuming lands them there.
  step: integer("step").notNull().default(1),

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

export const tenantDraftsRelations = relations(tenantDrafts, ({ one }) => ({
  owner: one(users, { fields: [tenantDrafts.ownerUserId], references: [users.id] }),
}));
