# Security

This document explains how the AI Chatbot Platform handles client credentials, what is stored, what guarantees exist, and the known limitations of the current security model.

---

## Credential Inventory

### AWS

| Field | Stored | Format | Used for |
|---|---|---|---|
| `deploymentRoleArn` | Yes | Plaintext | STS AssumeRole during onboarding and deployment |
| `awsAccountId` | Yes | Plaintext | Workflow inputs (not a secret — public identifier) |
| `awsRegion` | Yes | Plaintext | Workflow inputs |
| STS temporary credentials | **No** | In-memory only | Single-request write to Secrets Manager, then discarded |

### Azure

| Field | Stored | Format | Used for |
|---|---|---|---|
| `azureSubscriptionId` | Yes | Plaintext | Workflow inputs |
| `azureTenantId` | Yes | Plaintext | Workflow inputs |
| `azureClientId` | Yes | Plaintext | Workflow inputs |
| `azureClientSecret` | Yes | AES-256-GCM encrypted | Decrypted at deployment time, passed to GitHub Actions |
| `llmApiKey` | Yes | AES-256-GCM encrypted | Decrypted at deployment time, passed to GitHub Actions |

---

## Encryption at Rest

All secret values are encrypted using AES-256-GCM before being written to the database. The implementation is in [`src/lib/crypto.ts`](src/lib/crypto.ts).

- **Algorithm:** AES-256-GCM
- **Key length:** 256 bits (32 bytes), supplied via `PLATFORM_ENCRYPTION_KEY` environment variable
- **IV:** 12-byte random value generated per encryption call
- **Authentication:** GCM auth tag is stored alongside the ciphertext — tampered ciphertext will fail to decrypt

The stored format is `iv_hex:auth_tag_hex:ciphertext_hex`. No raw secret value is ever written to the database.

The encryption key must be set as an environment variable and must **not** be stored in the database or committed to source control.

---

## AWS Security Model

### How it works

When a tenant is created the platform calls `sts:AssumeRole` using the client-supplied role ARN. This produces short-lived temporary credentials (15-minute TTL) that are used in-memory to write the LLM API key to Secrets Manager. The credentials are then discarded — they are never written to the database, logs, or any storage layer.

During deployment, the GitHub Actions workflow re-assumes the same role (1-hour TTL) to run Terraform in the client account.

### Why clients retain control

The IAM role is created and owned by the client. The platform cannot assume it unless:

1. The client's trust policy explicitly lists the platform's AWS account as a trusted principal.
2. The role has not been deleted or had its trust policy removed.

The client can revoke the platform's access at any time by modifying or deleting the IAM role — no action needed on the platform side.

### Independent verification via CloudTrail

Every `sts:AssumeRole` call and every subsequent API call made under those temporary credentials is recorded in the client's own AWS CloudTrail. The platform cannot suppress or alter these logs. Clients can verify platform activity by filtering CloudTrail for:

- **Event name:** `AssumeRole`
- **Session name pattern:** `tenant-onboarding-{slug}` (onboarding) or `deploy-{slug}-*` (deployments)

This means clients do not need to trust the platform operator's claims — they can independently audit every action taken in their account.

### Recommended trust policy

The client's IAM role trust policy should be scoped as tightly as possible:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "AWS": "arn:aws:iam::PLATFORM_ACCOUNT_ID:root"
      },
      "Action": "sts:AssumeRole",
      "Condition": {
        "StringEquals": {
          "sts:ExternalId": "PLATFORM_EXTERNAL_ID"
        }
      }
    }
  ]
}
```

The `ExternalId` condition is important — see [Known Limitations](#known-limitations) below.

---

## Azure Security Model

### How it works

The client provides a service principal (client ID + secret) with Contributor access scoped to a single resource group. The client secret is encrypted immediately on receipt and stored encrypted in the database.

During deployment, the encrypted secret is decrypted server-side and passed as a masked input to the GitHub Actions workflow. GitHub Actions masks the value in all logs using `::add-mask::`. Terraform uses the credentials to provision infrastructure in the client's subscription.

The platform itself (the Next.js app) never authenticates against the client's Azure subscription outside of deployment operations.

### What the service principal can access

The Contributor role on a single resource group limits the blast radius of the service principal. It cannot:

- Access other resource groups or subscriptions
- Modify Azure AD / Entra ID settings
- Elevate its own permissions

Clients should create a dedicated service principal solely for use with this platform and assign it Contributor access only on the resource group used for the chatbot deployment.

---

## Credentials in Transit

### GitHub Actions workflow dispatch

Secrets consumed by the workflows are sent over HTTPS. How they reach the workflow differs by cloud:

- **AWS** (`deploy-tenant.yml`) — the LLM key is never passed to the workflow at all; it is written to the tenant's Secrets Manager during onboarding and injected into the container by the ECS execution role. The workflow only receives non-secret inputs plus `PINECONE_API_KEY` (a GitHub repo secret).
- **Azure** (`deploy-tenant-azure.yml`) — `AZURE_CLIENT_SECRET`, `LLM_API_KEY`, and `PINECONE_API_KEY` are read from **GitHub repo secrets**, not per-tenant workflow inputs.

Values referenced via `${{ secrets.* }}` are automatically masked by GitHub in all logs and the Actions UI; there is no explicit `::add-mask::` step. Secrets are still visible to GitHub as the service provider — an accepted limitation of the GitHub Actions model.

> ⚠️ The platform's `buildAzureInputs` (`src/lib/deploy.ts`) still decrypts the per-tenant `azureClientSecret` / `llmApiKeyEncrypted` and passes them as workflow inputs, but `deploy-tenant-azure.yml` does not declare those inputs and instead uses repo secrets. This mismatch means the credential flow described for Azure onboarding is not exercised by the current workflow — see the note in DOCS.md. Reconcile before relying on platform-triggered Azure deploys.

### Platform API surface

Credentials entered in the onboarding form are submitted over HTTPS to a Next.js Server Action. They are never echoed back to the client in API responses. The LLM API key field is rendered as `type="password"` with `autocomplete="off"`.

---

## Known Limitations

### 1. No ExternalId on AWS AssumeRole (should be added)

The current STS `AssumeRole` call does not include an `ExternalId`. Without it, any party who discovers a client's role ARN and is trusted by the platform's AWS account could potentially assume the role — this is the [confused deputy problem](https://docs.aws.amazon.com/IAM/latest/UserGuide/confused-deputy.html).

**Planned fix:** Add a platform-wide `ExternalId` (stored as `PLATFORM_EXTERNAL_ID`) to all `AssumeRole` calls. Clients would include this value in their trust policy condition. This ensures only this platform (not any arbitrary actor with the role ARN) can assume the role.

### 2. Azure client secret is decryptable by the platform operator

The encrypted `azureClientSecret` can be decrypted by anyone with access to both the platform database and the `PLATFORM_ENCRYPTION_KEY` environment variable. The platform operator must be trusted not to misuse stored credentials.

**Planned mitigation:** Migrate to [Azure Workload Identity Federation](https://learn.microsoft.com/en-us/entra/workload-id/workload-identity-federation) (OIDC). This eliminates long-lived client secrets entirely — the GitHub Actions workflow obtains a short-lived token from GitHub's OIDC provider and exchanges it for Azure credentials. Nothing to store.

### 3. Azure identifiers stored in plaintext

`azureSubscriptionId`, `azureTenantId`, and `azureClientId` are stored as plaintext. While these are identifiers rather than credentials, they are sensitive enough to warrant encryption. A future migration will apply the same AES-256-GCM treatment as `azureClientSecret`.

### 4. No per-deployment credential scope

The platform re-uses the same service principal / role for every deployment of a given tenant. There is no mechanism to issue scoped, single-use credentials per deployment run.

---

## Platform Operator Responsibilities

The following must be secured by the platform operator:

| Secret | Where set | Risk if exposed |
|---|---|---|
| `PLATFORM_ENCRYPTION_KEY` | Server environment variable | All stored client secrets become decryptable |
| `GITHUB_PAT` | Server environment variable | Attacker can trigger arbitrary workflow dispatches |
| `PLATFORM_WEBHOOK_SECRET` | Server env + GitHub Actions secret | Attacker can forge deployment status callbacks |
| `TF_STATE_BUCKET` | GitHub Actions secret | Reveals Terraform state storage location |

These values must never be committed to source control, logged, or included in error responses.

---

## Client Security Checklist

### AWS
- [ ] Create a dedicated IAM role used only for this platform
- [ ] Scope the role's permission policy to the minimum required (see [AWS requirements](README.md))
- [ ] Add an `ExternalId` condition to the trust policy (when supported by the platform)
- [ ] Enable CloudTrail in the deployment region to independently audit all platform activity
- [ ] Review and revoke the role if the tenant is deleted

### Azure
- [ ] Create a dedicated service principal used only for this platform
- [ ] Assign Contributor access only on the specific resource group for this deployment
- [ ] Use a separate service principal per tenant (not one shared across all tenants)
- [ ] Rotate the client secret periodically
- [ ] Delete the service principal when the tenant is no longer needed

### Both clouds
- [ ] Use a dedicated LLM API key for each tenant rather than a shared organization key
- [ ] Set spending limits on the LLM API key if the provider supports it
- [ ] Review the platform's open-source code before onboarding sensitive workloads

---

## Reporting Security Issues

To report a vulnerability, contact the platform maintainers directly rather than filing a public issue. Include a description of the issue, steps to reproduce, and the potential impact.
