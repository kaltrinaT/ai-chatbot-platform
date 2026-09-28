import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { deployments, tenants } from "@/db/schema";
import { decryptSecret } from "@/lib/crypto";
import { getChatbotRepo } from "@/lib/github";
import {
  GITHUB_OIDC_ISSUER,
  PLATFORM_SECRETS_AUDIENCE,
  tenantDeploySubject,
  workflowRef,
} from "@/lib/githubOidc";
import { AZURE_DEPLOY_WORKFLOW, AZURE_DESTROY_WORKFLOW, deployRef } from "@/lib/deploy";
import { ACTIVE_STATUSES } from "@/lib/reconcile";

/**
 * Releasing an Azure tenant's application secrets to the one workflow run
 * that is deploying it.
 *
 * AWS never needs this: onboarding writes the LLM, Pinecone and docs-signer
 * secrets into the customer's own Secrets Manager, and only ARNs travel. Azure
 * has no secret store until Terraform creates the Key Vault, so the run has to
 * get the values from the platform somehow. They used to be dispatch inputs,
 * which GitHub records in the run's event payload for anyone who can read the
 * repository. Instead the run now asks for them, and proves who it is with the
 * same thing the customer's federated credential trusts: a GitHub OIDC token
 * whose subject names this tenant's environment.
 *
 * What a caller has to prove, in order:
 *   1. GitHub signed the token, for the platform's own audience (not a cloud's)
 *   2. it comes from the platform's repository
 *   3. its subject is this deployment's tenant environment
 *   4. it was started by the Azure workflow for this kind of deployment, on the
 *      deploy ref — so the connection check, which runs in the same
 *      environment, cannot ask
 *   5. the deployment is still active, has not released its secrets before,
 *      and is not already tied to a different run
 *
 * The fifth check and the release are one conditional UPDATE, so two runs
 * racing for the same deployment cannot both win.
 */

export class SecretsRequestError extends Error {
  constructor(
    readonly status: 401 | 403 | 404 | 409,
    message: string,
  ) {
    super(message);
    this.name = "SecretsRequestError";
  }
}

export type RunClaims = {
  sub: string;
  repository: string;
  workflow_ref: string;
  run_id: string;
};

let githubKeys: JWTVerifyGetKey | undefined;

/** GitHub's published signing keys. jose caches and refreshes them itself. */
function githubJwks(): JWTVerifyGetKey {
  githubKeys ??= createRemoteJWKSet(new URL(`${GITHUB_OIDC_ISSUER}/.well-known/jwks`));
  return githubKeys;
}

/**
 * Verifies a run's OIDC token. Checks the signature, issuer, audience and
 * expiry only; what the claims have to say is releaseDeploymentSecrets' job.
 */
export async function verifyRunToken(
  token: string,
  keys: JWTVerifyGetKey = githubJwks(),
): Promise<RunClaims> {
  let payload: Record<string, unknown>;
  try {
    ({ payload } = await jwtVerify(token, keys, {
      issuer: GITHUB_OIDC_ISSUER,
      audience: PLATFORM_SECRETS_AUDIENCE,
      algorithms: ["RS256"],
    }));
  } catch {
    throw new SecretsRequestError(401, "The OIDC token is not a valid GitHub Actions token for this platform.");
  }

  const { sub, repository, workflow_ref, run_id } = payload;
  if (
    typeof sub !== "string" ||
    typeof repository !== "string" ||
    typeof workflow_ref !== "string" ||
    typeof run_id !== "string"
  ) {
    throw new SecretsRequestError(401, "The OIDC token is missing the claims that identify a workflow run.");
  }
  return { sub, repository, workflow_ref, run_id };
}

export type DeploySecrets = { llmApiKey: string; pineconeApiKey: string; docsSignerSecret: string };
export type DestroySecrets = { pineconeApiKey: string };

function decryptOrEmpty(blob: string | null): string {
  return blob ? decryptSecret(blob) : "";
}

export async function releaseDeploymentSecrets(
  deploymentId: string,
  token: string,
  keys?: JWTVerifyGetKey,
): Promise<DeploySecrets | DestroySecrets> {
  const claims = await verifyRunToken(token, keys);

  // Any repository on GitHub can mint a token for this audience, so the
  // repository is checked before the database is touched at all.
  const repo = getChatbotRepo();
  if (claims.repository !== `${repo.owner}/${repo.repo}`) {
    throw new SecretsRequestError(403, "The token was not issued to the platform's deploy repository.");
  }

  const [row] = await db
    .select({ deployment: deployments, tenant: tenants })
    .from(deployments)
    .innerJoin(tenants, eq(deployments.tenantId, tenants.id))
    .where(eq(deployments.id, deploymentId));
  if (!row) throw new SecretsRequestError(404, "Deployment not found.");
  const { deployment, tenant } = row;

  if (tenant.cloudProvider !== "azure") {
    throw new SecretsRequestError(
      409,
      "Only Azure deployments fetch secrets from the platform; AWS runs read them from the customer's own Secrets Manager.",
    );
  }

  if (claims.sub !== tenantDeploySubject(repo, tenant.id)) {
    throw new SecretsRequestError(403, "The token's subject is not this deployment's tenant environment.");
  }

  const workflow = deployment.kind === "destroy" ? AZURE_DESTROY_WORKFLOW : AZURE_DEPLOY_WORKFLOW;
  if (claims.workflow_ref !== workflowRef(repo, workflow, deployRef())) {
    throw new SecretsRequestError(403, `Only ${workflow} on the deploy ref may fetch these secrets.`);
  }

  // The run-started callback normally records the run ID first; if it was
  // lost, the claim records it instead, so either way one run owns the row.
  const [claimed] = await db
    .update(deployments)
    .set({
      secretsClaimedAt: new Date(),
      githubRunId: sql`coalesce(${deployments.githubRunId}, ${claims.run_id})`,
    })
    .where(
      and(
        eq(deployments.id, deploymentId),
        isNull(deployments.secretsClaimedAt),
        inArray(deployments.status, [...ACTIVE_STATUSES]),
        or(isNull(deployments.githubRunId), eq(deployments.githubRunId, claims.run_id)),
      ),
    )
    .returning({ id: deployments.id });
  if (!claimed) {
    throw new SecretsRequestError(
      409,
      "This deployment's secrets were already released, it has finished, or it belongs to another run. Start a new deployment from the platform.",
    );
  }

  const pineconeApiKey = decryptOrEmpty(tenant.pineconeApiKeyEncrypted);
  // A teardown writes nothing, so it gets only what destroying the Pinecone
  // index needs: Pinecone's API is not covered by an Azure token.
  if (deployment.kind === "destroy") return { pineconeApiKey };

  return {
    llmApiKey: decryptOrEmpty(tenant.llmApiKeyEncrypted),
    pineconeApiKey,
    docsSignerSecret: decryptOrEmpty(tenant.docsSignerSecretEncrypted),
  };
}
