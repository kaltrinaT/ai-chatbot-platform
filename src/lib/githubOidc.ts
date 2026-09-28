/**
 * What a workflow run proves about itself, and the one value that ties it to
 * a tenant.
 *
 * GitHub signs an OIDC token for every run that asks for one. The token's
 * `sub` claim describes the workload — which repository, and which ref or
 * environment it ran in — and a cloud that trusts GitHub decides what to
 * accept by matching that claim. It is the whole security boundary on both
 * clouds, so it is built in one place rather than spelled out per provider.
 *
 * The claim has to differ per tenant or the boundary does not exist. A ref
 * subject (repo:OWNER/REPO:ref:refs/heads/main) is identical for every
 * customer, so any tenant's deploy could sign in to any account that trusts
 * the platform's repository — an operator who typed someone else's role ARN or
 * client ID into the wizard would provision into a stranger's cloud. Running
 * each deploy in a GitHub environment named after the tenant puts the tenant
 * into the token instead, and every other tenant's trust refuses it.
 *
 * GitHub offers no way to put an arbitrary per-run value into the claim, so
 * the environment is the mechanism, not a preference. Private repositories
 * need GitHub Pro, Team or Enterprise for environments; without them this
 * fails closed, because the token carries no environment and no customer's
 * trust matches.
 *
 * The tenant ID is a platform-generated UUID rather than the slug, because the
 * operator chooses the slug.
 *
 * Pure functions with no environment access, so the onboarding wizard can
 * render the exact values a customer has to apply.
 */

export const GITHUB_OIDC_ISSUER = "https://token.actions.githubusercontent.com";

export type GithubRepo = { owner: string; repo: string };

/** Shown in place of a repository that the platform has not been told about. */
export const REPO_PLACEHOLDER: GithubRepo = { owner: "<owner>", repo: "<repo>" };

/**
 * The GitHub environment a tenant's deploy, teardown and verify runs execute
 * in. Keep in sync with `environment:` on the jobs in deploy-tenant.yml,
 * deploy-tenant-azure.yml, destroy-tenant.yml, destroy-tenant-azure.yml,
 * verify-tenant-aws.yml and verify-tenant-azure.yml — deployPipeline.test.ts
 * checks every one of them against this function.
 */
export function tenantDeployEnvironment(tenantId: string): string {
  return `tenant-${tenantId}`;
}

/**
 * The `sub` claim GitHub puts in those runs' tokens, which a customer's trust
 * must match exactly. Both clouds compare it case-sensitively, so owner and
 * repo have to be spelled the way GitHub spells them.
 */
export function tenantDeploySubject(repo: GithubRepo, tenantId: string): string {
  return `repo:${repo.owner}/${repo.repo}:environment:${tenantDeployEnvironment(tenantId)}`;
}

/**
 * The audience a run requests when it asks the platform itself for a tenant's
 * application secrets (see src/app/api/deployments/[id]/secrets/route.ts).
 *
 * Deliberately neither AWS's `sts.amazonaws.com` nor Azure's
 * `api://AzureADTokenExchange`, so a token minted to sign in to a customer's
 * cloud is never accepted here, and one minted for the platform is never
 * accepted by a cloud. Keep in sync with the "Fetch tenant secrets" steps in
 * deploy-tenant-azure.yml and destroy-tenant-azure.yml.
 */
export const PLATFORM_SECRETS_AUDIENCE = "ai-chatbot-platform:tenant-secrets";

/**
 * The `workflow_ref` claim GitHub writes into a run's token: which workflow
 * file started it, and from which ref. Pinning it means a different workflow
 * that happens to run in the same tenant environment — the connection check,
 * say — cannot ask for that tenant's secrets.
 */
export function workflowRef(repo: GithubRepo, workflowFile: string, ref: string): string {
  const fullRef = ref.startsWith("refs/") ? ref : `refs/heads/${ref}`;
  return `${repo.owner}/${repo.repo}/.github/workflows/${workflowFile}@${fullRef}`;
}
