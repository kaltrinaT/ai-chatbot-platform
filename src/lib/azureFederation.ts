/**
 * The trust an Azure customer grants the platform, in place of a client secret.
 *
 * The customer adds a federated identity credential to their own app
 * registration or user-assigned managed identity. It tells Entra ID to accept
 * a token signed by GitHub Actions, for one exact subject, as that identity.
 * The deploy workflow presents GitHub's OIDC token, Entra exchanges it for a
 * short-lived access token, and nothing reusable exists anywhere: not in the
 * platform database, not in GitHub, not in the workflow's inputs.
 *
 * The subject is what keeps one customer's trust from covering another's. A
 * branch-based subject (repo:OWNER/REPO:ref:refs/heads/main) would be the same
 * for every customer, so any tenant's deploy could log in to any subscription
 * that trusts the platform, and an operator who typed someone else's client ID
 * into the wizard would deploy into it. Running the job in a GitHub environment
 * named after the tenant puts the tenant into the token instead, and Entra
 * refuses every other tenant's runs. That is the Azure counterpart of a
 * per-customer sts:ExternalId on AWS.
 *
 * The tenant ID is a platform-generated UUID, not the slug, because the
 * operator chooses the slug.
 *
 * Pure functions with no environment access, so the onboarding wizard can
 * render the exact values the customer has to enter.
 */

import {
  GITHUB_OIDC_ISSUER,
  type GithubRepo,
  tenantDeployEnvironment,
  tenantDeploySubject,
} from "@/lib/githubOidc";

// Re-exported so callers that only care about Azure need one import. The
// issuer and the subject are GitHub's, not Azure's, and AWS now matches on
// the same two values — see githubOidc.ts.
export { GITHUB_OIDC_ISSUER };
export type { GithubRepo };

/** The audience Entra ID requires on a federated token. */
export const AZURE_FEDERATION_AUDIENCE = "api://AzureADTokenExchange";

/**
 * The GitHub environment deploy-tenant-azure.yml runs its job in. Keep in sync
 * with `environment:` on that job.
 */
export function azureDeployEnvironment(tenantId: string): string {
  return tenantDeployEnvironment(tenantId);
}

/**
 * The `sub` claim GitHub puts in the job's OIDC token, which the customer's
 * federated credential must match exactly. Entra compares it case-sensitively,
 * so owner and repo must be spelled the way GitHub spells them.
 */
export function azureFederatedSubject(repo: GithubRepo, tenantId: string): string {
  return tenantDeploySubject(repo, tenantId);
}

/** A name for the credential, unique per tenant within one identity. */
export function azureFederatedCredentialName(tenantId: string): string {
  return `ai-chatbot-platform-${tenantId}`;
}

/**
 * The Azure CLI command that creates the credential on an app registration.
 * `appId` is the client ID the customer enters in the wizard.
 */
export function azureFederatedCredentialCommand(
  repo: GithubRepo,
  tenantId: string,
  appId: string,
): string {
  const parameters = JSON.stringify({
    name: azureFederatedCredentialName(tenantId),
    issuer: GITHUB_OIDC_ISSUER,
    subject: azureFederatedSubject(repo, tenantId),
    audiences: [AZURE_FEDERATION_AUDIENCE],
  });
  return `az ad app federated-credential create --id ${appId || "<client-id>"} --parameters '${parameters}'`;
}

/**
 * The same credential on a user-assigned managed identity, which needs no
 * permission to create app registrations in Entra ID.
 */
export function azureManagedIdentityCredentialCommand(repo: GithubRepo, tenantId: string): string {
  return [
    "az identity federated-credential create",
    `--name ${azureFederatedCredentialName(tenantId)}`,
    "--identity-name <identity-name>",
    "--resource-group <identity-resource-group>",
    `--issuer ${GITHUB_OIDC_ISSUER}`,
    `--subject ${azureFederatedSubject(repo, tenantId)}`,
    `--audiences ${AZURE_FEDERATION_AUDIENCE}`,
  ].join(" ");
}
