import { randomBytes } from "node:crypto";
import { encryptSecret } from "@/lib/crypto";

/**
 * The platform application makes no Azure API calls of any kind. It holds no
 * Azure credential to make them with: deploys reach the customer's
 * subscription from GitHub Actions through a federated credential (see
 * azureFederation.ts), and nothing else needs to.
 */

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
