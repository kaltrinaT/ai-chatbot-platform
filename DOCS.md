# AI Chatbot Platform — Documentation

## What This Is

A SaaS control plane for deploying AI chatbots into customer cloud accounts (AWS or Azure). Platform operators sign in with GitHub, fill out a form with customer cloud credentials and an LLM API key, and the platform provisions all required infrastructure in the customer's account via Terraform, then hands back a live chatbot URL.

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Authentication](#authentication)
3. [Routes & Pages](#routes--pages)
4. [Database Schema](#database-schema)
5. [Tenant Onboarding Flow](#tenant-onboarding-flow)
6. [Deployment Workflows](#deployment-workflows)
7. [AWS Infrastructure](#aws-infrastructure)
8. [Azure Infrastructure](#azure-infrastructure)
9. [Secret & Credential Handling](#secret--credential-handling)
10. [Environment Variables](#environment-variables)
11. [AWS vs. Azure Comparison](#aws-vs-azure-comparison)
12. [File Structure](#file-structure)

---

## Architecture Overview

```
Browser (operator)
  └── Next.js App (App Router)
        ├── GitHub OAuth (NextAuth v5)
        ├── Server Actions (form submission)
        ├── Drizzle ORM → Neon Postgres
        ├── AWS SDK (STS + Secrets Manager)
        ├── Azure SDK (Key Vault)
        └── Octokit → GitHub Actions (workflow_dispatch)
                         └── Terraform (per-tenant infra)
                               └── POST /api/deployments/{id}/status
```

Every tenant deployment runs in the **customer's** cloud account. The platform only holds encrypted credentials and triggers the workflow; it never runs Terraform itself.

---

## Authentication

- Provider: GitHub OAuth via NextAuth v5 (`next-auth` beta)
- Strategy: database sessions (stored in the `sessions` table)
- Middleware at `src/middleware.ts` blocks all routes except `/signin`, `/api/auth/*`, and static assets

**Setup:**
```
AUTH_SECRET=          # npx auth secret
AUTH_GITHUB_ID=       # GitHub OAuth App client ID
AUTH_GITHUB_SECRET=   # GitHub OAuth App client secret
```

---

## Routes & Pages

| Route | Type | Description |
|---|---|---|
| `GET /` | Page | Dashboard — lists tenants and recent deployments |
| `GET /signin` | Page | GitHub sign-in button |
| `GET /tenants/new` | Page | New tenant onboarding form |
| `POST` (server action) | Action | `createTenantAndDeploy` — validates, inserts, triggers workflow |
| `GET /tenants/[id]` | Page | Tenant detail — config, deployment history, chatbot URL |
| `POST /api/deployments/[id]/status` | API route | Webhook receiver — GitHub Actions callbacks |
| `GET/POST /api/auth/[...nextauth]` | API route | NextAuth handlers |

### Webhook authorization

The status endpoint at `src/app/api/deployments/[id]/status/route.ts` requires an `x-webhook-secret` header matching `DEPLOY_WEBHOOK_SECRET`. Comparison is done with `timingSafeEqual` to prevent timing attacks.

---

## Database Schema

Managed by Drizzle ORM, running on Neon Postgres.

### `tenants`

| Column | Type | Notes |
|---|---|---|
| `id` | UUID | PK, auto-generated |
| `name` | text | Display name |
| `slug` | text | Unique, URL-safe identifier (3–32 chars; 18 max for Azure) |
| `ownerUserId` | text | FK → users |
| `cloudProvider` | enum | `aws` \| `azure` |
| `chatbotVersion` | text | Git/image tag deployed |
| `domain` | text | Optional custom domain |
| `llmProvider` | enum | `openai` \| `anthropic` |
| `llmApiKeyEncrypted` | text | AES-256-GCM encrypted |
| `albDnsName` | text | Populated by workflow callback (AWS) |
| `chatbotUrl` | text | Populated by workflow callback |
| `createdAt` / `updatedAt` | timestamp | — |

**AWS-only columns:** `awsAccountId`, `awsRegion`, `deploymentRoleArn`, `s3DocsPrefix`, `llmSecretArn`

**Azure-only columns:** `azureSubscriptionId`, `azureTenantId`, `azureClientId`, `azureClientSecretEncrypted`, `azureRegion`

### `deployments`

| Column | Type | Notes |
|---|---|---|
| `id` | UUID | PK |
| `tenantId` | UUID | FK → tenants |
| `triggeredByUserId` | text | FK → users |
| `status` | enum | `pending` → `running` → `succeeded` \| `failed` \| `cancelled` |
| `chatbotVersion` | text | Version deployed |
| `githubRunId` | text | GitHub Actions run ID |
| `githubRunUrl` | text | Direct link to Actions run |
| `startedAt` / `finishedAt` | timestamp | — |
| `errorMessage` | text | Set on failure |

### NextAuth tables

`users`, `accounts`, `sessions`, `verificationTokens` — managed by `@auth/drizzle-adapter`.

---

## Tenant Onboarding Flow

```
1. Operator fills /tenants/new form
   → Required for all: name, slug, chatbot version, LLM provider, LLM API key
   → AWS extra: AWS account ID, region, deployment role ARN, optional S3 prefix
   → Azure extra: subscription ID, tenant ID, client ID, client secret, region

2. Server action (actions.ts) validates with Zod

3. Encrypt LLM API key (AES-256-GCM) for DB storage

4a. AWS path:
    → AssumeRole into customer account (15-min session)
    → Write LLM secret to customer's Secrets Manager: {slug}/llm-api-key
    → Store returned ARN in tenant record

4b. Azure path:
    → Encrypt Azure client secret for DB storage
    → LLM key is NOT written now — Terraform does it during deploy

5. Insert tenant record

6. Insert deployment record (status: "pending")

7. Call GitHub workflow_dispatch via Octokit
   → AWS: deploy-tenant.yml
   → Azure: deploy-tenant-azure.yml

8. Update deployment status → "running"

9. Redirect to /tenants/{id}
```

---

## Deployment Workflows

### AWS — `.github/workflows/deploy-tenant.yml`

**Required GitHub repo secrets:**
- `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` (platform's AWS principal)
- `TF_STATE_BUCKET`, `TF_STATE_REGION` (S3 backend for Terraform state)
- `PLATFORM_BASE_URL` (e.g. `https://platform.example.com`)
- `PLATFORM_WEBHOOK_SECRET`

**Workflow steps:**
1. Pull chatbot image from platform ECR (platform credentials)
2. AssumeRole into customer account (3600s, `role-skip-session-tagging: true`)
3. Create ECR repo in customer account if absent; tag and push image
4. `terraform init` with S3 backend (`tenants/{slug}.tfstate`)
5. `terraform apply -auto-approve` — provisions all infra
6. Read outputs: `alb_dns_name`, `chatbot_url`
7. POST to `/api/deployments/{id}/status` with status + URLs + GitHub run details

### Azure — `.github/workflows/deploy-tenant-azure.yml`

**Same GitHub repo secrets as AWS, plus no extra Azure secrets** — all credentials are passed as workflow inputs from the platform.

**Workflow steps:**
1. Mask `llm_api_key` and `azure_client_secret` inputs in logs
2. Pull chatbot image from platform ECR
3. Azure login via service principal
4. Create resource group + ACR if absent; push image to ACR
5. `terraform init` with S3 backend (`tenants/azure/{slug}.tfstate`)
6. `terraform apply` — provisions infra, writes LLM key to Key Vault
7. Read outputs: `chatbot_url`, `container_app_fqdn`
8. POST callback to platform

---

## AWS Infrastructure

Defined in `infra/terraform/main.tf`. Everything is created in the **customer's** AWS account.

### Networking
- VPC `10.20.0.0/16` with DNS enabled
- 2 public subnets (`10.20.0.0/24`, `10.20.1.0/24`) across 2 AZs
- Internet Gateway + public route table

> Note: Tasks run with public IPs in public subnets to avoid NAT Gateway cost. Suitable for MVP; revisit for production with private subnets + VPC endpoints.

### Load Balancer
- Application Load Balancer (HTTP, port 80)
- Target group: IP mode, container port 8000, health check on `/`

### Compute
- ECS Fargate cluster + service (desired count: 1)
- Task defaults: 256 CPU units, 512 MB memory
- Container environment: `S3_DOCS_BUCKET`, `S3_DOCS_PREFIX`, `LLM_PROVIDER`, `AWS_REGION`, `PORT`
- LLM key injected as a secret from Secrets Manager (not an env var)

### Storage
- S3 bucket: `chatbot-{tenant_slug}-docs`
  - AES-256 server-side encryption
  - All public access blocked
  - Bucket name is set in `S3_DOCS_BUCKET` env var at container startup

### IAM
- **Execution role**: `AmazonECSTaskExecutionRolePolicy` + `secretsmanager:GetSecretValue` on LLM secret
- **Task role**: `s3:ListBucket` on docs bucket, `s3:GetObject` on `{bucket}/{prefix}*`

### CloudWatch
- Log group `/ecs/chatbot-{slug}`, 14-day retention

### Terraform variables

| Variable | Required | Description |
|---|---|---|
| `tenant_slug` | yes | 3–32 chars, lowercase alphanumeric + hyphens |
| `aws_region` | yes | e.g. `us-east-1` |
| `image_uri` | yes | Full ECR URI with tag in customer account |
| `llm_provider` | yes | `openai` or `anthropic` |
| `llm_secret_arn` | yes | Secrets Manager ARN (written by platform during onboarding) |
| `s3_docs_prefix` | no | Optional prefix scope within docs bucket |
| `domain` | no | Custom hostname |
| `container_port` | no | Default: 8000 |
| `task_cpu` / `task_memory` | no | Fargate sizing |

---

## Azure Infrastructure

Defined in `infra/terraform/azure/main.tf`. Everything is created in the **customer's** Azure subscription.

### Resources created

| Resource | Name pattern | Notes |
|---|---|---|
| Resource Group | `chatbot-{slug}` | Container for all resources |
| Container Registry | `chatbot{slug}acr` | Basic SKU, admin enabled |
| Key Vault | `cb-{slug}-kv` | Standard SKU; LLM key written here by Terraform |
| Storage Account | `chatbot{slug}` | Hyphens removed; 24-char max enforced |
| Blob container | `documents` | Private access |
| Log Analytics Workspace | `chatbot-{slug}-logs` | 14-day retention |
| Container App Environment | `chatbot-{slug}-env` | Linked to Log Analytics |
| Container App | `chatbot-{slug}` | Single revision mode |

### Container App config
- Min 1 replica, max 3 (autoscaling)
- External ingress on target port 8000
- Environment variables: `PORT`, `LLM_PROVIDER`, `AZURE_STORAGE_ACCOUNT`, `AZURE_STORAGE_CONTAINER`
- LLM key mounted as a secret from Key Vault

### Terraform variables

| Variable | Required | Notes |
|---|---|---|
| `tenant_slug` | yes | Max 18 chars (Key Vault naming limit) |
| `subscription_id`, `tenant_id`, `client_id`, `client_secret` | yes | Customer service principal |
| `azure_region` | yes | e.g. `eastus` |
| `image_uri` | yes | Full ACR image URI with tag |
| `llm_provider` | yes | `openai` or `anthropic` |
| `llm_api_key` | yes | Plain text; Terraform writes to Key Vault |
| `domain` | no | Custom hostname |
| `container_port` | no | Default: 8000 |

---

## Secret & Credential Handling

### LLM API key

**AWS:**
1. Received from form
2. Platform calls `assumeTenantRole` → assumes customer's IAM role
3. `writeLlmSecret` stores key in customer's Secrets Manager as `{slug}/llm-api-key`
4. ARN stored in `tenants.llmSecretArn`
5. ECS execution role reads it at task startup — key never touches platform disk after onboarding

**Azure:**
1. Received from form
2. Encrypted with AES-256-GCM, stored in `tenants.llmApiKeyEncrypted`
3. Decrypted only when building workflow inputs for `triggerDeployment`
4. Passed to Terraform as a variable; Terraform writes it to Key Vault
5. Container App mounts from Key Vault at runtime

### Azure client secret
- Encrypted with AES-256-GCM at rest in `tenants.azureClientSecretEncrypted`
- Decrypted only in `triggerDeployment` when building workflow inputs

### Encryption scheme (`src/lib/crypto.ts`)
- Algorithm: AES-256-GCM
- Key: 32-byte hex from `PLATFORM_ENCRYPTION_KEY`
- Stored format: `{iv_hex}:{authTag_hex}:{ciphertext_hex}`

---

## Environment Variables

```env
# ── Postgres ──────────────────────────────────────────────────────────
DATABASE_URL=postgres://user:password@host/db?sslmode=require

# ── NextAuth ──────────────────────────────────────────────────────────
AUTH_SECRET=                    # npx auth secret
AUTH_GITHUB_ID=
AUTH_GITHUB_SECRET=

# ── GitHub (trigger workflows) ────────────────────────────────────────
GITHUB_PAT=                     # Personal Access Token: repo + workflow scopes
CHATBOT_REPO_OWNER=             # GitHub username/org that owns the repo
CHATBOT_REPO_NAME=ai-chatbot-platform
CHATBOT_DEPLOY_WORKFLOW=deploy-tenant.yml   # overridable
CHATBOT_DEPLOY_REF=main                     # branch/tag workflows run from

# ── Webhook security ──────────────────────────────────────────────────
DEPLOY_WEBHOOK_SECRET=          # shared with GitHub Actions PLATFORM_WEBHOOK_SECRET

# ── Encryption ────────────────────────────────────────────────────────
PLATFORM_ENCRYPTION_KEY=        # openssl rand -hex 32

# ── AWS (platform's own principal) ────────────────────────────────────
AWS_ACCESS_KEY_ID=
AWS_SECRET_ACCESS_KEY=

# ── Chatbot image ─────────────────────────────────────────────────────
PLATFORM_CHATBOT_IMAGE_URI=     # ECR URI without tag, e.g.:
                                # 123456789012.dkr.ecr.us-east-1.amazonaws.com/chatbot
```

---

## AWS vs. Azure Comparison

| Aspect | AWS | Azure |
|---|---|---|
| Compute | ECS Fargate | Container Apps |
| Image registry | Customer ECR (replicated from platform ECR) | Customer ACR |
| LLM secret store | Secrets Manager (pre-created during onboarding) | Key Vault (created by Terraform during deploy) |
| LLM key flow | Written by platform → ARN stored → injected by ECS execution role | Encrypted in DB → passed to Terraform → written to Key Vault |
| Docs storage | S3 bucket `chatbot-{slug}-docs` | Blob container `documents` in Storage Account |
| Auth model | STS AssumeRole (3600s) | Long-lived service principal credentials |
| Network | Public subnets, ALB, public IPs | Container Apps managed networking |
| Terraform state key | `tenants/{slug}.tfstate` | `tenants/azure/{slug}.tfstate` |
| Slug max length | 32 chars | 18 chars (Key Vault name constraint) |
| Autoscaling | Fixed 1 replica (ECS desired_count) | 1–3 replicas (Container Apps) |

---

## File Structure

```
src/
  app/
    api/
      auth/[...nextauth]/route.ts       # NextAuth handlers
      deployments/[id]/status/route.ts  # Workflow callback webhook
    tenants/
      new/
        page.tsx                        # Onboarding form page
        TenantForm.tsx                  # Form UI (client component)
        actions.ts                      # Server action: validate, create, deploy
      [id]/
        page.tsx                        # Tenant detail (config + deployment history)
    signin/page.tsx                     # Sign-in page
    page.tsx                            # Dashboard
    layout.tsx                          # Root layout
    globals.css
  auth.ts                               # NextAuth config
  middleware.ts                         # Route auth guard
  db/
    index.ts                            # Drizzle + Neon setup
    schema.ts                           # All table definitions and relations
  lib/
    aws.ts                              # AssumeRole, writeLlmSecret
    azure.ts                            # writeAzureKeyVaultSecret
    crypto.ts                           # AES-256-GCM encrypt/decrypt
    deploy.ts                           # triggerDeployment, buildAwsInputs, buildAzureInputs

infra/
  terraform/
    main.tf                             # AWS: VPC, ALB, ECS, S3, IAM
    variables.tf                        # AWS input variables
    outputs.tf                          # alb_dns_name, chatbot_url
    azure/
      main.tf                           # Azure: resource group, ACR, Key Vault, Container App
      variables.tf                      # Azure input variables
      outputs.tf                        # chatbot_url, container_app_fqdn, key_vault_name

.github/
  workflows/
    deploy-tenant.yml                   # AWS deployment workflow
    deploy-tenant-azure.yml             # Azure deployment workflow
```
