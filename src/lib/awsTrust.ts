/**
 * What ties one customer's IAM role to one tenant.
 *
 * The role carries two trust statements, because two different callers need
 * it and they prove themselves in different ways.
 *
 * **Deploys and teardowns** come from GitHub Actions, which signs an OIDC
 * token naming the tenant's own environment (see githubOidc.ts). AWS validates
 * that token against the customer's own GitHub OIDC provider, so the platform
 * is not a party to the exchange at all: nothing reusable exists in the
 * platform database, in GitHub, or in the workflow's inputs, and STS issues
 * credentials that live only for the run.
 *
 * **Onboarding** is the one thing GitHub cannot do. The platform writes the
 * tenant's LLM key, Pinecone key and docs-signer secret straight into the
 * customer's Secrets Manager before any workflow exists, which is what keeps
 * those values out of GitHub Actions entirely — only the resulting ARNs ever
 * travel through a dispatch. That call is made by the platform itself, so the
 * role has to trust the platform's AWS account for it.
 *
 * That second statement is a confused-deputy risk, and `sts:ExternalId` is
 * what closes it. Trusting the platform account alone would cover every
 * request the platform makes, with no way to tell which tenant it is acting
 * for: anyone who reached the onboarding form and knew a role ARN (not a
 * secret — it appears in logs, screenshots and support threads, and the
 * required `chatbot-client-deploy-` prefix makes it guessable) could have the
 * platform write into someone else's account. The ExternalId is a value the
 * customer has put in their policy as a condition, issued by the platform and
 * never typed by whoever fills in the form, and STS refuses any call without
 * it. AWS's guidance is one value per customer; a single platform-wide value
 * would appear in every customer's policy and so would be sent by a tenant
 * created against someone else's role.
 *
 * Both statements name the same tenant UUID — as the ExternalId, and as the
 * environment inside the GitHub subject. One identifier, one trust decision
 * per tenant, on both clouds.
 *
 * Neither value is a secret. They are bindings, and they are expected to
 * appear in the customer's policy and in CloudTrail.
 *
 * Pure functions with no environment access, so the onboarding wizard can
 * render the exact policy the customer has to apply.
 */

import {
  GITHUB_OIDC_ISSUER,
  REPO_PLACEHOLDER,
  type GithubRepo,
  tenantDeployEnvironment,
  tenantDeploySubject,
} from "@/lib/githubOidc";

/** Shown in place of the platform's account ID when it is not configured. */
export const PLATFORM_ACCOUNT_PLACEHOLDER = "<platform-aws-account-id>";

/** Shown in place of the customer's account ID before they have entered it. */
export const CUSTOMER_ACCOUNT_PLACEHOLDER = "<your-aws-account-id>";

/** The audience AWS requires on a GitHub OIDC token. */
export const AWS_OIDC_AUDIENCE = "sts.amazonaws.com";

/**
 * The ExternalId for a tenant. Deliberately the tenant's row ID rather than a
 * separate column: it is already platform-generated, unique, and permanent, and
 * a second identifier would be one more thing to keep in step with the
 * customer's policy.
 */
export function awsExternalId(tenantId: string): string {
  return tenantId;
}

/** The GitHub environment this tenant's AWS runs execute in. */
export function awsDeployEnvironment(tenantId: string): string {
  return tenantDeployEnvironment(tenantId);
}

/** The `sub` claim the customer's OIDC trust statement must match. */
export function awsFederatedSubject(repo: GithubRepo, tenantId: string): string {
  return tenantDeploySubject(repo, tenantId);
}

/**
 * The ARN of the GitHub OIDC provider inside the customer's own account.
 *
 * An account holds at most one provider per issuer, so this ARN is the same
 * for every tenant in that account and the bootstrap stack creates it only
 * when it is not already there.
 */
export function awsOidcProviderArn(customerAccountId: string | null): string {
  const account = customerAccountId?.trim() || CUSTOMER_ACCOUNT_PLACEHOLDER;
  return `arn:aws:iam::${account}:oidc-provider/token.actions.githubusercontent.com`;
}

/**
 * The trust policy the customer applies to their deployment role. Shown by the
 * wizard and on the tenant page with the tenant's own values filled in, for a
 * customer who would rather apply it by hand than run the bootstrap stack —
 * infra/bootstrap/aws/tenant-bootstrap.yaml creates exactly this.
 */
export function awsTrustPolicy(opts: {
  platformAccountId: string | null;
  customerAccountId?: string | null;
  githubRepo?: GithubRepo | null;
  tenantId: string;
}): string {
  const platformAccount = opts.platformAccountId?.trim() || PLATFORM_ACCOUNT_PLACEHOLDER;
  const repo = opts.githubRepo ?? REPO_PLACEHOLDER;

  return JSON.stringify(
    {
      Version: "2012-10-17",
      Statement: [
        {
          // Deploys, teardowns and connection checks. No platform involvement.
          Sid: "GitHubActionsDeploy",
          Effect: "Allow",
          Principal: { Federated: awsOidcProviderArn(opts.customerAccountId ?? null) },
          Action: "sts:AssumeRoleWithWebIdentity",
          Condition: {
            // StringEquals, not StringLike: a wildcard in the subject would
            // let any environment in the repository — so any other tenant's
            // deploy — assume this role.
            StringEquals: {
              [`${new URL(GITHUB_OIDC_ISSUER).host}:aud`]: AWS_OIDC_AUDIENCE,
              [`${new URL(GITHUB_OIDC_ISSUER).host}:sub`]: awsFederatedSubject(repo, opts.tenantId),
            },
          },
        },
        {
          // Onboarding only: writing this tenant's secrets into their own
          // Secrets Manager, which is what keeps those values out of CI.
          Sid: "PlatformOnboarding",
          Effect: "Allow",
          Principal: { AWS: `arn:aws:iam::${platformAccount}:root` },
          Action: "sts:AssumeRole",
          Condition: { StringEquals: { "sts:ExternalId": awsExternalId(opts.tenantId) } },
        },
      ],
    },
    null,
    2,
  );
}
