import { db } from "@/db";
import { tenants, deployments, tenantDocuments, tenantDrafts } from "@/db/schema";
import { and, eq, desc, ilike, isNull, isNotNull, or } from "drizzle-orm";

export type TenantRow = typeof tenants.$inferSelect;
export type DeploymentRow = typeof deployments.$inferSelect;

export async function getActiveTenants(ownerId: string): Promise<TenantRow[]> {
  return db
    .select()
    .from(tenants)
    .where(and(eq(tenants.ownerUserId, ownerId), isNull(tenants.deletedAt)));
}

// Deliberately unpaginated at the SQL level: the /chatbots page filters by a
// *derived* status (from the latest deployment, not a tenant column) and
// sorts/paginates the result of that — all of which have to compose on the
// same in-memory list (see filterAndSortTenants in ./selectors). Search and
// the cloud/LLM/vector-store filters below are all real tenant columns, so
// they stay in SQL — cheaper, and one less thing for the JS layer to do.
export async function getTenantsForOwner(
  ownerId: string,
  {
    showDeleted,
    search,
    cloud,
    llmProvider,
    vectorStore,
  }: {
    showDeleted: boolean;
    search?: string;
    cloud?: "aws" | "azure";
    llmProvider?: "openai" | "anthropic" | "openrouter";
    vectorStore?: "pinecone" | "pgvector";
  },
): Promise<TenantRow[]> {
  return db
    .select()
    .from(tenants)
    .where(
      and(
        eq(tenants.ownerUserId, ownerId),
        showDeleted ? isNotNull(tenants.deletedAt) : isNull(tenants.deletedAt),
        search ? or(ilike(tenants.name, `%${search}%`), ilike(tenants.slug, `%${search}%`)) : undefined,
        cloud ? eq(tenants.cloudProvider, cloud) : undefined,
        llmProvider ? eq(tenants.llmProvider, llmProvider) : undefined,
        vectorStore ? eq(tenants.vectorStore, vectorStore) : undefined,
      ),
    )
    .orderBy(showDeleted ? desc(tenants.deletedAt) : desc(tenants.createdAt));
}

export type DeployJoinRow = { deployment: DeploymentRow; tenantName: string; tenantSlug: string };

// Every deployment for the user's tenants, newest first. Not filtered by
// tenant deletedAt: a destroy's own deployment row is exactly what makes
// that status transition visible.
export async function getAllDeploys(ownerId: string): Promise<DeployJoinRow[]> {
  return db
    .select({ deployment: deployments, tenantName: tenants.name, tenantSlug: tenants.slug })
    .from(deployments)
    .innerJoin(tenants, eq(deployments.tenantId, tenants.id))
    .where(eq(tenants.ownerUserId, ownerId))
    .orderBy(desc(deployments.startedAt));
}

export type DraftRow = typeof tenantDrafts.$inferSelect;

// Unfinished onboarding forms. Without this the wizard's "Save Draft" is a
// one-way door: a draft is only resumable via /tenants/new?draft=<id>, and
// nothing else in the UI ever surfaces that id.
export async function getDraftsForOwner(ownerId: string): Promise<DraftRow[]> {
  return db
    .select()
    .from(tenantDrafts)
    .where(eq(tenantDrafts.ownerUserId, ownerId))
    .orderBy(desc(tenantDrafts.updatedAt));
}

export type DocJoinRow = { document: typeof tenantDocuments.$inferSelect; tenantName: string };

export async function getAllDocs(ownerId: string): Promise<DocJoinRow[]> {
  return db
    .select({ document: tenantDocuments, tenantName: tenants.name })
    .from(tenantDocuments)
    .innerJoin(tenants, eq(tenantDocuments.tenantId, tenants.id))
    .where(eq(tenants.ownerUserId, ownerId));
}
