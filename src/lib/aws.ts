import { STSClient, AssumeRoleCommand } from "@aws-sdk/client-sts";
import {
  SecretsManagerClient,
  CreateSecretCommand,
  UpdateSecretCommand,
} from "@aws-sdk/client-secrets-manager";

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

export async function writeLlmSecret(opts: {
  credentials: AssumedCredentials;
  region: string;
  secretName: string;
  secretValue: string;
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
        Description: "LLM API key for the AI chatbot tenant (managed by ai-chatbot-platform)",
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
