import { randomBytes } from "node:crypto";
import {
  STSClient,
  AssumeRoleCommand,
  AssumeRoleWithWebIdentityCommand,
} from "@aws-sdk/client-sts";
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

/** The platform's own credentials are unusable, before any customer is touched. */
export class PlatformCredentialsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlatformCredentialsError";
  }
}

/**
 * The platform calls AWS only with temporary credentials, never with a stored
 * access key. The SDK's default chain does not know that: with no profile set
 * it falls back to any static key in the environment or ~/.aws/credentials.
 * Temporary credentials always carry a session token, and long-lived IAM user
 * keys never do.
 */
export class LongLivedAwsKeyError extends PlatformCredentialsError {
  constructor() {
    super(
      "The platform refuses to call AWS with a long-lived access key. Remove AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY from its environment, run aws login --profile platform-operator, and set AWS_PROFILE=platform-control-plane.",
    );
    this.name = "LongLivedAwsKeyError";
  }
}

type PlatformCredentialProvider = () => Promise<AssumedCredentials & { expiration?: Date }>;

/**
 * The token the host signs to prove which workload is asking.
 *
 * Vercel mints one per invocation and delivers it as a request header, putting
 * it in the environment only at build time — its own helper reads the header
 * first for exactly that reason. Onboarding always runs inside a request, so
 * the header is the path that matters; the environment variables cover another
 * host, or a context with no request to read.
 */
async function hostOidcToken(): Promise<string | undefined> {
  const fromEnvironment =
    process.env.VERCEL_OIDC_TOKEN?.trim() || process.env.PLATFORM_AWS_WEB_IDENTITY_TOKEN?.trim();
  if (fromEnvironment) return fromEnvironment;

  try {
    const { headers } = await import("next/headers");
    return (await headers()).get("x-vercel-oidc-token")?.trim() || undefined;
  } catch {
    // No request to read a header from, which is itself an answer: there is
    // no token here.
    return undefined;
  }
}

/**
 * The identity the platform itself acts as, before it assumes anything inside
 * a customer's account.
 *
 * On a host that signs its own OIDC token — Vercel, and the same shape any
 * other federating host uses — PLATFORM_AWS_ROLE_ARN names the role to
 * exchange that token for, and no key, profile or human is involved. Unset,
 * the SDK's default chain applies instead: the operator's `aws login` session
 * on a developer machine, or the compute role if the platform is ever hosted
 * inside AWS.
 */
function platformCredentials(region: string): PlatformCredentialProvider | undefined {
  const roleArn = process.env.PLATFORM_AWS_ROLE_ARN?.trim();
  if (!roleArn) return undefined;

  return async () => {
    const webIdentityToken = await hostOidcToken();
    if (!webIdentityToken) {
      throw new PlatformCredentialsError(
        "PLATFORM_AWS_ROLE_ARN is set but this host issued no OIDC token, so the platform cannot federate to AWS. On Vercel, turn on OIDC federation for the project; on another host, supply PLATFORM_AWS_WEB_IDENTITY_TOKEN.",
      );
    }

    // This call needs no credentials of its own: the signed token is the proof
    // of identity, which is the whole point of federating.
    const sts = new STSClient({ region });
    const res = await sts.send(
      new AssumeRoleWithWebIdentityCommand({
        RoleArn: roleArn,
        RoleSessionName: "platform-control-plane",
        WebIdentityToken: webIdentityToken,
        DurationSeconds: 3600,
      }),
    );

    const c = res.Credentials;
    if (!c?.AccessKeyId || !c.SecretAccessKey || !c.SessionToken) {
      throw new PlatformCredentialsError(
        "STS AssumeRoleWithWebIdentity returned incomplete credentials",
      );
    }
    return {
      accessKeyId: c.AccessKeyId,
      secretAccessKey: c.SecretAccessKey,
      sessionToken: c.SessionToken,
      expiration: c.Expiration,
    };
  };
}

export async function assumeTenantRole(opts: {
  roleArn: string;
  sessionName: string;
  region: string;
}): Promise<AssumedCredentials> {
  const sts = new STSClient({
    region: opts.region,
    credentials: platformCredentials(opts.region),
  });
  // Resolved before send, so a refused key never signs a request. Whatever the
  // source was — federation above, a sign-in session, a compute role — this is
  // where a static key is caught.
  const callerCredentials = await sts.config.credentials();
  if (!callerCredentials.sessionToken) {
    throw new LongLivedAwsKeyError();
  }
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
