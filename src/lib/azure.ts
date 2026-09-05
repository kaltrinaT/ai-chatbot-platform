import { randomBytes } from "node:crypto";
import { ClientSecretCredential } from "@azure/identity";
import { SecretClient } from "@azure/keyvault-secrets";
import { encryptSecret } from "@/lib/crypto";

export type AzureCredentials = {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  subscriptionId: string;
};

export async function writeAzureKeyVaultSecret(opts: {
  credentials: AzureCredentials;
  keyVaultName: string;
  secretName: string;
  secretValue: string;
}): Promise<string> {
  const credential = new ClientSecretCredential(
    opts.credentials.tenantId,
    opts.credentials.clientId,
    opts.credentials.clientSecret
  );

  const vaultUrl = `https://${opts.keyVaultName}.vault.azure.net`;
  const client = new SecretClient(vaultUrl, credential);

  const result = await client.setSecret(opts.secretName, opts.secretValue, {
    contentType: "text/plain",
  });

  if (!result.properties.id) {
    throw new Error("Key Vault setSecret returned no secret ID");
  }

  // Return vault URI (without version) so the workflow can always fetch latest
  return `${vaultUrl}/secrets/${opts.secretName}`;
}

/**
 * Generates the docs-signer Function's shared auth secret at onboarding.
 * Unlike ensureDocsSignerSecret in aws.ts, this makes NO Azure API call: the
 * tenant's Key Vault doesn't exist yet at onboarding time — Terraform
 * creates it during deploy, in the same apply as azurerm_key_vault_secret.docs_signer
 * (see infra/terraform/azure/main.tf). The platform's only durable copy is
 * its own encrypted one, which — unlike AWS's write-once-then-ARN-only
 * pattern — must be decrypted and resent as a masked deploy input on every
 * deploy, since there's nothing in the tenant's Azure subscription to read
 * it back from beforehand. This mirrors how llmApiKeyEncrypted is already
 * handled for Azure tenants.
 */
export function generateDocsSignerSecret(): {
  docsSignerSecretEncrypted: string;
  docsSignerSecretPlaintext: string;
} {
  const docsSignerSecretPlaintext = randomBytes(32).toString("hex");
  return {
    docsSignerSecretEncrypted: encryptSecret(docsSignerSecretPlaintext),
    docsSignerSecretPlaintext,
  };
}
