import { randomBytes } from "node:crypto";
import { STSClient, AssumeRoleCommand } from "@aws-sdk/client-sts";
import {
  SecretsManagerClient,
  CreateSecretCommand,
  UpdateSecretCommand,
} from "@aws-sdk/client-secrets-manager";
import { encryptSecret } from "@/lib/crypto";

export type AssumedCredentials = {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
};

export async function assumeTenantRole(opts: {
  roleArn: string;
  sessionName: string;
  region: string;
}): Promise<AssumedCredentials> {
  const sts = new STSClient({ region: opts.region });
  const res = await sts.send(
    new AssumeRoleCommand({
      RoleArn: opts.roleArn,
      RoleSessionName: opts.sessionName,
      DurationSeconds: 900,
    }),
  );

  const c = res.Credentials;
  if (!c?.AccessKeyId || !c.SecretAccessKey || !c.SessionToken) {
    throw new Error("STS AssumeRole returned incomplete credentials");
  }

  return {
    accessKeyId: c.AccessKeyId,
    secretAccessKey: c.SecretAccessKey,
    sessionToken: c.SessionToken,
  };
}

/**
 * Write a secret into the CUSTOMER's Secrets Manager using assumed credentials
 * and return its ARN. Keeping the value here — rather than passing it as a
 * workflow input — is why AWS deploys never expose tenant keys to GitHub
 * Actions; only the resulting ARN travels.
 */
export async function writeTenantSecret(opts: {
  credentials: AssumedCredentials;
  region: string;
  secretName: string;
  secretValue: string;
  description: string;
}): Promise<string> {
  const client = new SecretsManagerClient({
    region: opts.region,
    credentials: opts.credentials,
  });

  try {
    const res = await client.send(
      new CreateSecretCommand({
        Name: opts.secretName,
        SecretString: opts.secretValue,
        Description: opts.description,
      }),
    );
    if (!res.ARN) throw new Error("CreateSecret returned no ARN");
    return res.ARN;
  } catch (err) {
    if (err instanceof Error && err.name === "ResourceExistsException") {
      const upd = await client.send(
        new UpdateSecretCommand({
          SecretId: opts.secretName,
          SecretString: opts.secretValue,
        }),
      );
      if (!upd.ARN) throw new Error("UpdateSecret returned no ARN");
      return upd.ARN;
    }
    throw err;
  }
}

/**
 * Generates the docs-signer Lambda's shared auth secret and writes it into
 * the tenant's own Secrets Manager (once — like the LLM/Pinecone keys, only
 * the ARN travels through Terraform afterward). The platform also keeps its
 * own encrypted copy, because unlike the LLM key it needs the plaintext
 * value again later — every document upload/delete sends it as a header to
 * the tenant's docs-signer Lambda — and re-fetching it from the tenant's AWS
 * account on every operation would mean the platform touches tenant AWS
 * credentials for documents on an ongoing basis, defeating the point.
 */
export async function ensureDocsSignerSecret(opts: {
  roleArn: string;
  region: string;
  slug: string;
  sessionName: string;
}): Promise<{ docsSignerSecretArn: string; docsSignerSecretEncrypted: string }> {
  const secretValue = randomBytes(32).toString("hex");
  const creds = await assumeTenantRole({
    roleArn: opts.roleArn,
    sessionName: opts.sessionName,
    region: opts.region,
  });
  const docsSignerSecretArn = await writeTenantSecret({
    credentials: creds,
    region: opts.region,
    secretName: `${opts.slug}/docs-signer-secret`,
    secretValue,
    description:
      "Shared auth secret for the docs-signer Lambda (managed by ai-chatbot-platform)",
  });
  return { docsSignerSecretArn, docsSignerSecretEncrypted: encryptSecret(secretValue) };
}
