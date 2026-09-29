/**
 * The resource names a chatbot's slug produces that have to be unique across
 * a whole cloud, not just within the customer's account.
 *
 * Two customers, or a customer and a stranger, can therefore collide even
 * though every slug on the platform is unique: Azure drops the hyphens from
 * storage account and registry names and shortens them, so `product-chatbot98`
 * and `product-chatbot99` both need the function storage account
 * `chatbotproductchatbot9fn`, and whoever deploys second fails half way
 * through `terraform apply`. These mirror the Terraform expressions exactly —
 * the test holds them to the source — so the platform can see a collision at
 * the slug, before anything is created.
 *
 * Pure functions: shared by the server's checks and their tests.
 */

import { azureStateStorageAccountName } from "@/lib/bootstrapLinks";

export type GlobalName = {
  /** What the name is for, in the customer's terms. */
  resource: string;
  name: string;
  /** The public host that exists exactly when the name is taken. */
  host: string;
  /**
   * Created by the customer's own setup, before the chatbot is submitted. Its
   * existing then is expected, not someone else holding it, so it is left out
   * when asking who else holds a name — or every onboarding would be refused
   * by the setup it had just run.
   */
  createdBySetup?: true;
};

/** Every globally unique name an Azure chatbot with this slug is built with. */
export function azureGlobalNames(slug: string): GlobalName[] {
  const compact = `chatbot${slug}`.replace(/-/g, "");
  const docsStorage = compact.slice(0, 24);
  const functionStorage = `${compact.slice(0, 22)}fn`;
  const registry = compact.slice(0, 50);
  const stateStorage = azureStateStorageAccountName(slug);
  return [
    { resource: "documents storage account", name: docsStorage, host: `${docsStorage}.blob.core.windows.net` },
    { resource: "function storage account", name: functionStorage, host: `${functionStorage}.blob.core.windows.net` },
    {
      resource: "Terraform state storage account",
      name: stateStorage,
      host: `${stateStorage}.blob.core.windows.net`,
      createdBySetup: true,
    },
    { resource: "container registry", name: registry, host: `${registry}.azurecr.io` },
    { resource: "key vault", name: `cb-${slug}-kv`, host: `cb-${slug}-kv.vault.azure.net` },
    {
      resource: "document-signing function",
      name: `chatbot-${slug}-docs-signer`,
      host: `chatbot-${slug}-docs-signer.azurewebsites.net`,
    },
    // Built only for pgvector tenants, but the slug is chosen before the
    // vector store is, so it is held to this name either way.
    {
      resource: "vector database",
      name: `chatbot-${slug}-pg`,
      host: `chatbot-${slug}-pg.postgres.database.azure.com`,
    },
  ];
}

/**
 * The one globally unique name an AWS chatbot has. Its state bucket sits in
 * the account-regional namespace, and everything else is unique per account.
 */
export function awsGlobalNames(slug: string): GlobalName[] {
  const bucket = `chatbot-${slug}-docs`;
  return [{ resource: "documents bucket", name: bucket, host: `${bucket}.s3.amazonaws.com` }];
}

/** The first name the two slugs would both need in Azure, if any. */
export function sharedAzureName(a: string, b: string): GlobalName | null {
  const theirs = new Set(azureGlobalNames(b).map((n) => n.name));
  return azureGlobalNames(a).find((n) => theirs.has(n.name)) ?? null;
}
