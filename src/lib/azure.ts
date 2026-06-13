import { ClientSecretCredential } from "@azure/identity";
import { SecretClient } from "@azure/keyvault-secrets";

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
