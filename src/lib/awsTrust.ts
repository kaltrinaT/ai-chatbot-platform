/**
 * What ties a customer's IAM roles to one tenant.
 *
 * Two roles, because two different callers need the customer's account and
 * they must be able to do very different things there.
 *
 * **The deployment role** serves deploys, teardowns and connection checks.
 * They come from GitHub Actions, which signs an OIDC token naming the tenant's
 * own environment (see githubOidc.ts). AWS validates that token against the
 * customer's own GitHub OIDC provider, so the platform is not a party to the
 * exchange at all: nothing reusable exists in the platform database, in
 * GitHub, or in the workflow's inputs, and STS issues credentials that live
 * only for the run. This role builds infrastructure, so it can reach the
 * whole account, documents included. It trusts GitHub and nothing else.
 *
 * **The onboarding role** serves the one thing GitHub cannot do. The platform
 * writes the tenant's LLM key, Pinecone key and docs-signer secret straight
 * into the customer's Secrets Manager before any workflow exists, which is
 * what keeps those values out of GitHub Actions entirely — only the resulting
 * ARNs ever travel through a dispatch. That call is made by the platform
 * itself, so this role trusts the platform's AWS account, and it may only
 * create and overwrite this tenant's secrets. It cannot read a secret back,
 * and it cannot see a document.
 *
 * They used to be one role carrying both trust statements. Since the platform
 * could assume it, the platform could also read every document in the
 * account — the opposite of ARCHITECTURE.md's control-plane boundary, and
 * what docs/evaluation/security (test S2) found. Splitting the role is what
 * makes the boundary true: the role the platform can assume holds no
 * permission that reaches tenant data.
 *
 * The onboarding trust is a confused-deputy risk, and `sts:ExternalId` is
 * what closes it. Trusting the platform account alone would cover every
 * request the platform makes, with no way to tell which tenant it is acting
 * for: anyone who reached the onboarding form and knew a role ARN (not a
 * secret — it appears in logs, screenshots and support threads, and the fixed
 * name prefix makes it guessable) could have the platform write into someone
 * else's account. The ExternalId is a value the customer has put in their
 * policy as a condition, issued by the platform and never typed by whoever
 * fills in the form, and STS refuses any call without it. AWS's guidance is
 * one value per customer; a single platform-wide value would appear in every
 * customer's policy and so would be sent by a tenant created against someone
 * else's role.
 *
 * Both roles name the same tenant UUID — as the ExternalId, and as the
 * environment inside the GitHub subject. One identifier, one trust decision
 * per tenant, on both clouds.
 *
 * Neither value is a secret. They are bindings, and they are expected to
 * appear in the customer's policies and in CloudTrail.
 *
 * Pure functions with no environment access, so the onboarding wizard can
 * render the exact policies the customer has to apply.
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
 * Name prefixes the customer's two roles must carry. The platform's own IAM
 * policy may assume only the onboarding prefix (infra/platform/control-plane),
 * so the deployment role stays out of its reach even if a customer's trust
 * policy were to name the platform.
 */
export const AWS_DEPLOY_ROLE_PREFIX = "chatbot-client-deploy-";
export const AWS_ONBOARDING_ROLE_PREFIX = "chatbot-client-onboard-";

/**
 * The onboarding role that belongs to a deployment role. Derived rather than
 * asked for: the bootstrap stack creates both in the same account under the
 * same slug, so the form keeps one ARN field.
 */
export function awsOnboardingRoleArn(deploymentRoleArn: string): string {
  const match = new RegExp(`^(arn:aws[a-z-]*:iam::\\d{12}:role/)${AWS_DEPLOY_ROLE_PREFIX}(.+)$`).exec(
    deploymentRoleArn.trim(),
  );
  if (!match) {
    throw new Error(`Not a ${AWS_DEPLOY_ROLE_PREFIX}* role ARN: ${deploymentRoleArn}`);
  }
  return `${match[1]}${AWS_ONBOARDING_ROLE_PREFIX}${match[2]}`;
}

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
 * infra/bootstrap/aws/tenant-bootstrap.yaml creates exactly this. GitHub is
 * the only principal: the platform has no way into this role.
 */
export function awsTrustPolicy(opts: {
  customerAccountId?: string | null;
  githubRepo?: GithubRepo | null;
  tenantId: string;
}): string {
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
      ],
    },
    null,
    2,
  );
}

/**
 * The trust policy of the onboarding role: the platform's account, and only
 * when it names this tenant as the ExternalId.
 */
export function awsOnboardingTrustPolicy(opts: {
  platformAccountId: string | null;
  tenantId: string;
}): string {
  const platformAccount = opts.platformAccountId?.trim() || PLATFORM_ACCOUNT_PLACEHOLDER;

  return JSON.stringify(
    {
      Version: "2012-10-17",
      Statement: [
        {
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

/**
 * Everything the onboarding role may do: create this tenant's secrets, and
 * overwrite them when onboarding is retried. Not GetSecretValue, so the
 * platform cannot read back what it wrote, and nothing outside Secrets
 * Manager. The trailing slash keeps one tenant's secrets apart from another
 * whose slug starts the same way (acme/ versus acme-corp/).
 */
export function awsOnboardingPermissions(opts: {
  customerAccountId?: string | null;
  tenantSlug: string;
}): string {
  const account = opts.customerAccountId?.trim() || CUSTOMER_ACCOUNT_PLACEHOLDER;

  return JSON.stringify(
    {
      Version: "2012-10-17",
      Statement: [
        {
          Sid: "WriteChatbotSecrets",
          Effect: "Allow",
          Action: ["secretsmanager:CreateSecret", "secretsmanager:UpdateSecret"],
          Resource: `arn:aws:secretsmanager:*:${account}:secret:${opts.tenantSlug}/*`,
        },
      ],
    },
    null,
    2,
  );
}
