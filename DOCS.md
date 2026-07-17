# AI Chatbot Platform — Documentation

## What This Is

A SaaS control plane for deploying AI chatbots into customer cloud accounts (AWS or Azure). Platform operators sign in with GitHub, fill out a form with customer cloud credentials and an LLM API key, and the platform provisions all required infrastructure in the customer's account via Terraform, then hands back a live chatbot URL.

---

## Control Plane / Data Plane Boundary

**This platform is a control plane only.** It deploys and monitors infrastructure. It has no access to the data plane.

The platform does **not** see, store, or transmit:
- Chat queries or answers
- Customer documents or embeddings
- Pinecone index contents
- CloudWatch or Log Analytics logs from the chatbot
- Any runtime traffic passing through the chatbot

All of that lives exclusively inside the customer's cloud account. The only information that flows back to the platform is deployment lifecycle data: whether Terraform succeeded or failed, and the resulting chatbot URL.

**This boundary is intentional and must be preserved.** Do not add endpoints that receive chatbot queries, answers, or documents. Do not add cross-account IAM roles or Azure delegated access for reading customer logs. Customers retain full ownership and privacy of their data.

If a customer wants query analytics or conversation logging, that is their own concern — they can ship their own tooling into their cloud account.

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
13. [Cost Breakdown](#cost-breakdown)

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
| `llmProvider` | enum | `openai` \| `anthropic` \| `openrouter` |
| `llmModel` | text | Optional model override; defaults per provider |
| `llmBaseUrl` | text | Optional LLM API base URL override |
| `llmApiKeyEncrypted` | text | AES-256-GCM encrypted |
| `albDnsName` | text | Populated by workflow callback (AWS) |
| `chatbotUrl` | text | Populated by workflow callback |
| `config` | jsonb | Free-form extra config; defaults to `{}` |
| `createdAt` / `updatedAt` | timestamp | — |

**AWS-only columns:** `awsAccountId`, `awsRegion`, `deploymentRoleArn`, `s3DocsBucket`, `s3DocsPrefix`, `llmSecretArn`

**Azure-only columns:** `azureSubscriptionId`, `azureTenantId`, `azureClientId`, `azureClientSecretEncrypted`, `azureResourceGroup`, `azureRegion`, `azureStorageAccount`, `azureStorageContainer`, `azureKeyVaultName`

> Note: `llmSecretArn` lives in the shared column group in `schema.ts` but is only populated for AWS tenants (null for Azure).

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
- `PINECONE_API_KEY` (platform-wide Pinecone key; passed to Terraform as a `-var`)

**Workflow steps:**
1. Pull **backend** and **frontend (chat UI)** images from platform ECR (platform credentials)
2. AssumeRole into customer account (3600s, `role-skip-session-tagging: true`)
3. Create ECR repos in customer account if absent (`{slug}/chatbot`, `{slug}/chatbot-frontend`); tag and push both images
4. `terraform init` with S3 backend (`tenants/{slug}.tfstate`)
5. `terraform apply -auto-approve` — provisions all infra
6. Read outputs: `alb_dns_name`, `chatbot_url`
7. POST to `/api/deployments/{id}/status` with status + URLs + GitHub run details

### Azure — `.github/workflows/deploy-tenant-azure.yml`

**Workflow inputs (`workflow_dispatch`):** `tenant_slug`, `llm_provider` (choice), `azure_region`, `image_tag`. Everything else comes from **GitHub repo secrets**, not workflow inputs.

**Required GitHub repo secrets:**
- `AZURE_SUBSCRIPTION_ID`, `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET` (the deploy service principal)
- `LLM_API_KEY`, `PINECONE_API_KEY`
- `TF_STATE_BUCKET`, `TF_STATE_REGION` (S3 backend), `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` (to reach the S3 state backend)
- `BACKEND_REPO_PAT` (optional — to check out the `ai-chatbot` source repo)

**Workflow steps:**
1. Check out the platform repo and the `{owner}/ai-chatbot` repo (backend + frontend source)
2. Compute resource names (ACR name, image URIs)
3. Azure login via service principal (from secrets)
4. `terraform init` with S3 backend (`azure/tenants/{slug}/terraform.tfstate`)
5. `terraform apply` (bootstrap, `-target` RG + ACR) with placeholder image URIs
6. `az acr login`, then build and push **backend** (`ai-chatbot/ai-backend`) and **frontend** (`ai-chatbot/ai-frontend`) images to the ACR
7. `terraform apply` (full) — provisions infra, writes LLM + Pinecone keys to Key Vault
8. Print `chatbot_url` to the job summary

> **Note:** Azure builds both images from source, whereas AWS replicates prebuilt images from the platform ECR.

> ⚠️ **Known inconsistency (code, not docs):** The platform's `buildAzureInputs` in [`src/lib/deploy.ts`](src/lib/deploy.ts) dispatches per-tenant inputs (`azure_subscription_id`, `azure_client_secret`, `llm_api_key`, `deployment_id`, `source_ecr_image`, …) that this workflow does **not** declare, and the workflow does **not** POST a status callback. As written, a platform-triggered Azure deployment would fail on unrecognized inputs and would never update the deployment record. Either the workflow or `deploy.ts` needs to be reconciled; this doc describes the workflow as it currently exists.

---

## AWS Infrastructure

Defined in `infra/terraform/main.tf`. Everything is created in the **customer's** AWS account.

### Networking
- VPC `10.20.0.0/16` with DNS enabled
- 2 public subnets (`10.20.0.0/24`, `10.20.1.0/24`) across 2 AZs
- Internet Gateway + public route table

> Note: Tasks run with public IPs in public subnets to avoid NAT Gateway cost. Suitable for MVP; revisit for production with private subnets + VPC endpoints.

### Load Balancer
- Application Load Balancer (HTTP, port 80) with path-based routing:
  - **Default action** → frontend target group (IP mode, port 80, health check on `/`)
  - **Rule `/api/*`** (priority 10) → backend target group (IP mode, port 8000, health check on `/api/health`)
- A user hits one URL (`chatbot_url`); the ALB serves the UI from `/` and routes API calls to the backend, so the frontend needs no API proxy.

### Compute
Two ECS Fargate services in one cluster (each desired count: 1):
- **Backend** (`chatbot-{slug}`) — container `chatbot`, image `{slug}/chatbot:{version}`; defaults 1024 CPU units / 2048 MB
  - Environment: `S3_DOCS_BUCKET`, `S3_DOCS_PREFIX`, `LLM_PROVIDER`, `AWS_REGION`, `PORT`, `OPENAI_BASE_URL`, `OPENAI_API_BASE`, `LLM_MODEL`, `PINECONE_INDEX` (hardcoded to `chatbot-shared` — one shared index across tenants, isolated by metadata filter)
  - Secrets injected from Secrets Manager: `LLM_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` (all → LLM secret), `PINECONE_API_KEY` (→ Pinecone secret)
- **Frontend** (`chatbot-{slug}-frontend`) — container `frontend` (nginx :80), image `{slug}/chatbot-frontend:{version}`; defaults 256 CPU units / 512 MB

### Storage
- S3 bucket: `chatbot-{tenant_slug}-docs`
  - AES-256 server-side encryption
  - All public access blocked
  - Bucket name is set in `S3_DOCS_BUCKET` env var at container startup

### Secrets Manager
- **LLM key**: `{slug}/llm-api-key` — written by the platform during onboarding (see below)
- **Pinecone key**: `{slug}/pinecone-api-key` — created by Terraform from the `pinecone_api_key` var (sourced from the platform-wide `PINECONE_API_KEY` GitHub secret)

### IAM
- **Execution role**: `AmazonECSTaskExecutionRolePolicy` + `secretsmanager:GetSecretValue` on **both** the LLM secret and the Pinecone secret
- **Task role**: `s3:ListBucket` on docs bucket, `s3:GetObject` on `{bucket}/{prefix}*`

### CloudWatch
- Log group `/ecs/chatbot-{slug}`, 14-day retention

### Terraform variables

| Variable | Required | Description |
|---|---|---|
| `tenant_slug` | yes | 3–32 chars, lowercase alphanumeric + hyphens |
| `aws_region` | yes | e.g. `us-east-1` |
| `image_uri` | yes | Full backend ECR URI with tag in customer account |
| `frontend_image_uri` | yes | Full frontend (chat UI) ECR URI with tag in customer account |
| `llm_provider` | yes | `openai`, `anthropic`, or `openrouter` |
| `llm_secret_arn` | yes | Secrets Manager ARN (written by platform during onboarding) |
| `pinecone_api_key` | yes | Pinecone API key (sensitive); Terraform writes it to Secrets Manager |
| `llm_model` | no | Model override; empty string uses the per-provider default |
| `s3_docs_prefix` | no | Optional prefix scope within docs bucket |
| `domain` | no | Custom hostname |
| `container_port` | no | Backend port, default: 8000 |
| `frontend_port` | no | Frontend port, default: 80 |
| `task_cpu` / `task_memory` | no | Backend Fargate sizing (default 1024 / 2048) |
| `frontend_cpu` / `frontend_memory` | no | Frontend Fargate sizing (default 256 / 512) |

---

## Azure Infrastructure

Defined in `infra/terraform/azure/main.tf`. Everything is created in the **customer's** Azure subscription.

### Resources created

| Resource | Name pattern | Notes |
|---|---|---|
| Resource Group | `chatbot-{slug}` | Container for all resources |
| Container Registry | `chatbot{slug}acr` | Basic SKU, admin enabled (name: hyphens stripped, 50-char max) |
| Key Vault | `cb-{slug}-kv` | Standard SKU; stores `llm-api-key`, `pinecone-api-key`, and `storage-key` (all written by Terraform) |
| Storage Account | `chatbot{slug}` | Hyphens removed; 24-char max enforced |
| Blob container | `documents` | Private access |
| Log Analytics Workspace | `chatbot-{slug}-logs` | 30-day retention (PerGB2018 SKU) |
| Container App Environment | `chatbot-{slug}-env` | Linked to Log Analytics |
| Container App | `chatbot-{slug}` | Single revision mode; two containers (backend + frontend) |

### Container App config
- Min 1 replica, max 3 (autoscaling)
- Container App secrets: `acr-password`, `llm-api-key`, `pinecone-api-key`, `storage-key`
- **Two containers in one app** (Container Apps has no path-based ingress routing, so both share localhost):
  - `chatbot` (backend, 0.5 vCPU / 1 Gi) — env `PORT`, `LLM_PROVIDER`, `AZURE_STORAGE_ACCOUNT`, `AZURE_STORAGE_CONTAINER`, `PINECONE_INDEX` (`chatbot-shared`), `PINECONE_ENVIRONMENT`, `OPENAI_BASE_URL`, `OPENAI_API_BASE`, `LLM_MODEL`; secret-backed env `LLM_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` (← `llm-api-key`), `PINECONE_API_KEY` (← `pinecone-api-key`), `AZURE_STORAGE_KEY` (← `storage-key`)
  - `frontend` (chat UI, nginx :80, 0.25 vCPU / 0.5 Gi) — env `BACKEND_PORT`; nginx serves the SPA and proxies `/api` → `localhost:8000`
- External ingress on **target port 80** → frontend container

### Terraform variables

| Variable | Required | Notes |
|---|---|---|
| `tenant_slug` | yes | Max 18 chars (Key Vault naming limit) |
| `azure_subscription_id`, `azure_tenant_id`, `azure_client_id`, `azure_client_secret` | yes | Customer service principal (all validated as UUIDs except the secret) |
| `azure_region` | yes | e.g. `eastus` (default `eastus`) |
| `image_uri` | yes | Full backend ACR image URI with tag |
| `frontend_image_uri` | yes | Full frontend (chat UI) ACR image URI with tag |
| `llm_provider` | yes | `openai`, `anthropic`, or `openrouter` |
| `llm_api_key` | yes | Plain text (sensitive); Terraform writes to Key Vault |
| `pinecone_api_key` | yes | Pinecone API key (sensitive); Terraform writes to Key Vault |
| `pinecone_environment` | no | Pinecone serverless region; default `us-east-1` |
| `llm_model` | no | Model override; empty string uses the per-provider default |
| `domain` | no | Custom hostname |
| `container_port` | no | Backend port, default: 8000 |
| `frontend_port` | no | Frontend port, default: 80 |

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

# ── Chatbot images (AWS replicates these prebuilt images per tenant) ──
PLATFORM_CHATBOT_IMAGE_URI=     # backend ECR URI without tag, e.g.:
                                # 123456789012.dkr.ecr.us-east-1.amazonaws.com/chatbot
PLATFORM_FRONTEND_IMAGE_URI=    # frontend (chat UI) ECR URI without tag, e.g.:
                                # 123456789012.dkr.ecr.us-east-1.amazonaws.com/chatbot-frontend
```

---

## AWS vs. Azure Comparison

| Aspect | AWS | Azure |
|---|---|---|
| Compute | ECS Fargate (2 services: backend + frontend) | Container Apps (1 app, 2 containers) |
| UI routing | ALB path routing: `/api/*` → backend, `/` → frontend | nginx in frontend proxies `/api` → backend over localhost |
| Image source | Replicated prebuilt from platform ECR (backend + frontend) | Built from `ai-chatbot` source (backend + frontend) and pushed to ACR |
| LLM secret store | Secrets Manager (pre-created during onboarding) | Key Vault (created by Terraform during deploy) |
| LLM key flow | Written by platform → ARN stored → injected by ECS execution role | Encrypted in DB → passed to Terraform → written to Key Vault |
| Docs storage | S3 bucket `chatbot-{slug}-docs` | Blob container `documents` in Storage Account |
| Auth model | STS AssumeRole (3600s) | Long-lived service principal credentials |
| Network | Public subnets, ALB, public IPs | Container Apps managed networking |
| Terraform state key | `tenants/{slug}.tfstate` | `azure/tenants/{slug}/terraform.tfstate` |
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
    main.tf                             # AWS: VPC, ALB (path routing), ECS backend + frontend services, S3, IAM
    variables.tf                        # AWS input variables (incl. frontend_image_uri)
    outputs.tf                          # alb_dns_name, chatbot_url
    azure/
      main.tf                           # Azure: resource group, ACR, Key Vault, Container App (backend + frontend containers)
      variables.tf                      # Azure input variables (incl. frontend_image_uri)
      outputs.tf                        # chatbot_url, container_app_fqdn, key_vault_name

.github/
  workflows/
    deploy-tenant.yml                   # AWS deployment workflow
    deploy-tenant-azure.yml             # Azure deployment workflow
```

---

## Cost Breakdown

All infrastructure runs in the **client's** cloud account. The platform itself incurs no per-tenant charges beyond the Neon Postgres plan and GitHub Actions minutes. The costs below are what each client pays in their own cloud account.

Prices shown are for **us-east-1 (AWS)** and **East US (Azure)**. Other regions vary by up to ~20%. All figures assume 730 hours/month (one full month, 24/7).

These estimates also surface **in-product** (computed in `src/lib/pricing.ts`): a per-resource breakdown card on each tenant detail page and a live preview on the onboarding form. For **actual** per-tenant spend, every resource Terraform creates is tagged `Tenant = {slug}` (and `Project = ai-chatbot-platform`): on AWS, activate the tag under Billing → Cost allocation tags and filter Cost Explorer by it; on Azure, group by the tag in Cost Management → Cost analysis. This keeps cost reporting entirely inside the client's account — the platform never reads their billing data.

---

### AWS Cost per Tenant

#### Default sizing (backend 1024 vCPU units / 2048 MB; frontend 256 / 512)

| Resource | Details | Monthly est. |
|---|---|---|
| **ECS Fargate — backend** | 1 vCPU, 2 GB, 1 replica | ~$36 |
| **ECS Fargate — frontend** | 0.25 vCPU, 0.5 GB, 1 replica | ~$9 |
| **Application Load Balancer** | Fixed hourly + LCU charges | ~$18–22 |
| **ECR** | 2 repos, ~500 MB images | ~$1 |
| **Secrets Manager** | 2 secrets (LLM key + Pinecone key) | ~$0.80 |
| **S3 — docs bucket** | Storage + requests (usage-based) | ~$0.50–5 |
| **CloudWatch Logs** | 14-day retention, low traffic | ~$1–3 |
| **Data transfer** | Outbound to internet ($0.09/GB) | variable |
| **Total (idle / light traffic)** | | **~$66–77/month** |

> The backend default was raised to 1 vCPU / 2 GB (`task_cpu = 1024`, `task_memory = 2048`) because the embedding model needs the memory headroom — see the note in CHATBOT-LOGIC.md. Drop it to `256 / 512` for a lighter (~$38–50/month) footprint if your backend image doesn't load a local model.
>
> **Pinecone** is billed separately by Pinecone (not AWS/Azure). The serverless free tier covers light usage; paid usage is per-read/write/storage.

#### Recommended production sizing (512 vCPU units / 1 024 MB per service)

Set `task_cpu = 512`, `task_memory = 1024`, `frontend_cpu = 512`, `frontend_memory = 1024` in the Terraform variables.

| Resource | Details | Monthly est. |
|---|---|---|
| **ECS Fargate — backend** | 0.5 vCPU, 1 GB, 1 replica | ~$18 |
| **ECS Fargate — frontend** | 0.5 vCPU, 1 GB, 1 replica | ~$18 |
| **Application Load Balancer** | Fixed + LCU | ~$18–22 |
| **ECR + Secrets Manager + S3 + CW** | Same as above | ~$5–10 |
| **Total** | | **~$60–70/month** |

> **Note:** The current Terraform config uses public subnets with public IPs to avoid NAT Gateway costs (~$32/month). Moving to private subnets would add that cost but improve network isolation.

---

### Azure Cost per Tenant

Azure Container Apps (Consumption plan) bills per second of active CPU and memory. With `min_replicas = 1` the app is always-on and billed continuously. Each subscription gets a monthly free tier of 180,000 vCPU-seconds and 360,000 GiB-seconds — only significant if you have very few tenants.

#### Default sizing (backend 0.5 vCPU / 1 Gi; frontend 0.25 vCPU / 0.5 Gi)

| Resource | Details | Monthly est. |
|---|---|---|
| **Container App — backend** | 0.5 vCPU, 1 Gi, always-on | ~$39 |
| **Container App — frontend** | 0.25 vCPU, 0.5 Gi, always-on | ~$20 |
| **Container Registry (Basic)** | Image storage | ~$5 |
| **Key Vault (Standard)** | Secret ops | ~$0.50 |
| **Storage Account (LRS)** | Docs storage + transactions | ~$1–5 |
| **Log Analytics Workspace** | 30-day retention, 5 GB/month free | ~$0–5 |
| **Total (idle / light traffic)** | | **~$66–75/month** |

> These figures match the sizing `infra/terraform/azure/main.tf` actually deploys (an earlier revision of this table assumed two 0.5 vCPU / 1 Gi containers, ~$83–92/month).

> Azure Container Apps is more expensive than AWS Fargate at idle because each container is billed individually with no equivalent of Fargate's combined task pricing. The cost advantage of Azure shows at high burst traffic where autoscaling kicks in (1–3 replicas).

---

### LLM API Costs

LLM costs are entirely usage-based and billed by the LLM provider directly to the client. They depend on the model chosen and query volume.

#### Pricing reference (as of mid-2026)

| Provider | Model | Input | Output |
|---|---|---|---|
| **OpenAI** | GPT-4o | $2.50 / 1M tokens | $10.00 / 1M tokens |
| **OpenAI** | GPT-4o mini | $0.15 / 1M tokens | $0.60 / 1M tokens |
| **Anthropic** | Claude Sonnet 4.6 | $3.00 / 1M tokens | $15.00 / 1M tokens |
| **Anthropic** | Claude Haiku 4.5 | $0.80 / 1M tokens | $4.00 / 1M tokens |

#### Estimated LLM spend by query volume

Assumes average query: 1,500 input tokens (system prompt + retrieved docs + user message) and 300 output tokens.

| Queries/month | GPT-4o | GPT-4o mini | Claude Sonnet 4.6 | Claude Haiku 4.5 |
|---|---|---|---|---|
| 1,000 | ~$7 | ~$0.40 | ~$9 | ~$2.40 |
| 5,000 | ~$34 | ~$2 | ~$45 | ~$12 |
| 10,000 | ~$68 | ~$4 | ~$90 | ~$24 |
| 50,000 | ~$338 | ~$19 | ~$450 | ~$120 |

> Input token counts grow significantly if you're injecting large document chunks via RAG. A retrieval setup injecting 4 chunks of 400 tokens each adds ~1,600 tokens per query — roughly doubling input costs.

---

### Total Cost of Ownership per Tenant

Combining infrastructure + LLM at typical usage levels (5,000 queries/month, GPT-4o mini):

| | AWS | Azure |
|---|---|---|
| Infrastructure | ~$38–50/month | ~$83–92/month |
| LLM (GPT-4o mini) | ~$2/month | ~$2/month |
| LLM (GPT-4o) | ~$34/month | ~$34/month |
| **Total (GPT-4o mini)** | **~$40–52/month** | **~$85–94/month** |
| **Total (GPT-4o)** | **~$72–84/month** | **~$117–126/month** |

---

### Cost Optimisation Tips

**AWS**
- Use **Fargate Spot** for the frontend service — it handles interruptions gracefully (static UI, nginx) and costs ~70% less than on-demand.
- **CloudWatch log retention** is already set to 14 days. Reduce to 7 if logs are not needed for auditing.
- Consider **Savings Plans** if tenants are expected to run for 12+ months — up to 52% discount on Fargate.
- The ALB fixed cost (~$16/month) is per-ALB. If you have many low-traffic tenants in one account, investigate sharing an ALB across tenants using host-based routing rules.

**Azure**
- Scale `min_replicas` to `0` for dev/test tenants (Container Apps scale-to-zero) — compute cost drops to near zero when idle. Note: first request after scale-to-zero has a cold-start delay of a few seconds.
- Use **Azure Hybrid Benefit** if the client has existing Windows Server / SQL licences — can reduce effective Container Apps pricing.
- **Log Analytics** costs can grow fast. Set a daily data cap in the workspace if you are not using the logs for alerting.
- **ACR Basic** is cheap (~$5/month) but has no geo-replication. Sufficient for single-region deployments.
