# AI Chatbot Platform — Documentation

## What This Is

A SaaS control plane for deploying AI chatbots into customer cloud accounts (AWS or Azure). Platform operators sign in with GitHub and fill out a form with the customer's cloud identifiers and an LLM API key. The customer runs a one-click setup in their own cloud that lets this chatbot's deployments sign in, and no cloud credential is ever handed to the platform. The platform then provisions all required infrastructure in the customer's account via Terraform, run by GitHub Actions, and hands back a live chatbot URL.

---

## Control Plane / Data Plane Boundary

**This platform is a control plane only.** It deploys and monitors infrastructure. It has no access to the data plane.

The platform does **not** see, store, or transmit:
- Chat queries or answers
- Customer source documents
- CloudWatch or Log Analytics logs from the chatbot
- Any runtime traffic passing through the chatbot

All of that lives exclusively inside the customer's cloud account. The only information that flows back to the platform is deployment lifecycle data: whether Terraform succeeded or failed, and the resulting chatbot URL.

**Vector storage is a per-tenant choice.** Tenants either bring their own Pinecone project (dedicated index `chatbot-{slug}`, key supplied at onboarding) or have a PostgreSQL + pgvector database provisioned inside their own cloud account. Neither option leaves the platform holding standing access to embeddings. See "Configurable vector store" in `ARCHITECTURE.md`.

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
        ├── AWS SDK (STS + Secrets Manager) — AWS onboarding only
        └── Octokit → GitHub Actions (workflow_dispatch)
                         ├── signs in to the customer's cloud with the run's
                         │   GitHub OIDC token (environment tenant-{id})
                         ├── Terraform (per-tenant infra, state in the customer's cloud)
                         ├── POST /api/deployments/{id}/secrets   (Azure runs only)
                         └── POST /api/deployments/{id}/status
```

Every tenant deployment runs in the **customer's** cloud account. The platform holds encrypted application secrets (LLM, Pinecone and docs-signer keys) and no cloud credential of any kind. It triggers the workflow; it never runs Terraform itself, and it makes no Azure calls at all.

---

## Authentication

- Provider: GitHub OAuth via NextAuth v5 (`next-auth` beta)
- Strategy: database sessions (stored in the `sessions` table)
- A request proxy at `src/proxy.ts` blocks all routes except `/signin`, `/api/auth/*`, and static assets — through the `authorized` callback in [`src/auth.ts`](src/auth.ts), since `next-auth` authorizes every request when that callback is absent. Next 16 renamed the middleware convention to `proxy`, whose runtime is Node.js; as edge middleware this guard could not open a database session at all
- **Authorization:** none by default — a completed GitHub sign-in reaches the platform. `AUTH_ALLOWED_EMAILS` optionally narrows that to named accounts, by the email address on the GitHub account (see [`src/lib/operators.ts`](src/lib/operators.ts)); when set it is checked as the session is created and again whenever `auth()` resolves one, so striking an address off ends that operator's access on their next request. An invitation step is future work — see Known Limitation #7 in [`SECURITY.md`](SECURITY.md)
- The deployment status webhook is the one path let through without a session; it authenticates its own `x-webhook-secret` header

**Setup:**
```
AUTH_SECRET=            # npx auth secret
AUTH_GITHUB_ID=         # GitHub OAuth App client ID
AUTH_GITHUB_SECRET=     # GitHub OAuth App client secret
AUTH_ALLOWED_EMAILS=    # optional: operator emails, comma-separated
```

---

## Routes & Pages

| Route | Type | Description |
|---|---|---|
| `GET /` | Page | Dashboard — tenants and recent deployments |
| `GET /chatbots` | Page | Tenant list, plus saved onboarding drafts |
| `GET /activity`, `GET /issues` | Page | Deployment activity across tenants, and everything that needs attention |
| `GET /guides/...` | Page | In-app guides: getting started, cloud prerequisites, deployment, security, document handling |
| `GET /signin` | Page | GitHub sign-in button |
| `GET /tenants/new` | Page | Five-step onboarding wizard; the last step shows live deployment progress |
| Server actions (`tenants/new/actions.ts`) | Action | `checkSlugAvailable`, `checkDeploymentIdentity` (asked as the operator types), `createTenantAndDeploy`, `saveTenantDraft`, `deleteTenantDraft` |
| `GET /tenants/[id]` | Page | Tenant detail — config, setup, deployment history, documents, redeploy, test connection, delete |
| `POST /api/deployments/[id]/status` | API route | Webhook receiver — GitHub Actions callbacks |
| `POST /api/deployments/[id]/secrets` | API route | Releases an Azure tenant's secrets, once, to its own deploy or teardown run, on proof of the run's GitHub OIDC token |
| `GET /api/deployments/[id]/progress` | API route | Live progress for a running deployment, read from the GitHub API; reconciles a finished run whose webhook was lost |
| `GET/POST /api/auth/[...nextauth]` | API route | NextAuth handlers |

### Webhook authorization

The status endpoint at `src/app/api/deployments/[id]/status/route.ts` requires an `x-webhook-secret` header matching `DEPLOY_WEBHOOK_SECRET`. Comparison is done with `timingSafeEqual` to prevent timing attacks.

---

## Database Schema

Managed by Drizzle ORM, running on Neon Postgres.

### `tenants`

| Column | Type | Notes |
|---|---|---|
| `id` | UUID | PK. Generated by the wizard when it opens, because the customer's setup trusts it before the row exists |
| `name` | text | Display name |
| `slug` | text | Unique, URL-safe identifier (3–21 chars; 18 max for Azure) |
| `ownerUserId` | text | FK → users |
| `cloudProvider` | enum | `aws` \| `azure` |
| `chatbotVersion` | text | Git/image tag deployed |
| `domain` | text | Optional custom domain |
| `llmProvider` | enum | `openai` \| `anthropic` \| `openrouter` |
| `llmModel` | text | Optional model override; defaults per provider |
| `llmBaseUrl` | text | Optional LLM API base URL override |
| `llmApiKeyEncrypted` | text | AES-256-GCM encrypted |
| `vectorStore` | enum | `pinecone` \| `pgvector`; default `pinecone` |
| `pineconeApiKeyEncrypted` | text | Customer's own Pinecone key, AES-256-GCM encrypted; null for pgvector |
| `pineconeSecretArn` | text | AWS only — ARN of the customer-account Pinecone secret |
| `albDnsName` | text | Populated by workflow callback (AWS) |
| `chatbotUrl` | text | Populated by workflow callback |
| `docsSignerSecretEncrypted` | text | The docs-signer's shared secret, AES-256-GCM encrypted; erased when the tenant is deleted |
| `docsSignerUrl` | text | The tenant's docs-signer, checked before it is stored and before every use |
| `config` | jsonb | Free-form extra config (e.g. `retrieval_min_score`); defaults to `{}` |
| `createdAt` / `updatedAt` | timestamp | — |
| `deletedAt` | timestamp | Soft delete, set by a successful teardown; the row is kept as the audit trail, its secrets erased |

**AWS-only columns:** `awsAccountId`, `awsRegion`, `deploymentRoleArn`, `s3DocsBucket`, `s3DocsPrefix`, `acmCertificateArn`, `llmSecretArn`, `docsSignerSecretArn`

**Azure-only columns:** `azureSubscriptionId`, `azureTenantId`, `azureClientId`, `azureResourceGroup`, `azureRegion`, `azureStorageAccount`, `azureStorageContainer`, `azureKeyVaultName`

> Note: `llmSecretArn` lives in the shared column group in `schema.ts` but is only populated for AWS tenants (null for Azure).

### `deployments`

| Column | Type | Notes |
|---|---|---|
| `id` | UUID | PK |
| `tenantId` | UUID | FK → tenants |
| `triggeredByUserId` | text | FK → users |
| `kind` | enum | `deploy` \| `destroy` |
| `status` | enum | `pending` → `running` → `succeeded` \| `failed` \| `cancelled`; forward only, and at most one `pending`/`running` per tenant (unique index) |
| `chatbotVersion` | text | Version deployed |
| `githubRunId` | text | GitHub Actions run ID |
| `githubRunUrl` | text | Direct link to Actions run |
| `secretsClaimedAt` | timestamp | Azure: when the run fetched its secrets; set once |
| `startedAt` / `finishedAt` | timestamp | — |
| `errorMessage` | text | Set on failure |

### `tenant_documents`

The platform's own list of a tenant's documents (see `DOCUMENT-MANAGEMENT.md`): `objectKey` (minted by the docs-signer), `displayName`, `contentType`, `sizeBytes`, `status` (`pending` \| `uploaded` \| `failed`), `uploadedByUserId`.

### `tenant_drafts`

An unfinished onboarding wizard: `ownerUserId`, `name`, `step`, `data` (jsonb). Secrets are stripped before saving. The generated tenant ID is kept, because the customer's setup may already trust it.

### NextAuth tables

`users`, `accounts`, `sessions`, `verificationTokens` — managed by `@auth/drizzle-adapter`.

---

## Tenant Onboarding Flow

```
1. Operator opens /tenants/new; the wizard generates the tenant ID (UUID)
   → The slug is checked as it is typed (checkSlugAvailable): against every
     tenant, live or deleted; on Azure against the names live Azure tenants
     derive from their slugs; and against DNS (Azure) or S3 (AWS) for the
     globally unique names someone outside the platform may hold
   → Once the slug is free, the wizard shows the customer's one-click setup:
     AWS: a CloudFormation Quick Create link (role, GitHub OIDC trust, state bucket)
     Azure: a Deploy to Azure link, or the az deployment sub create command
            (resource group, managed identity, federated credential, state storage)
   → The customer pastes back the role ARN or client ID the setup outputs;
     checkDeploymentIdentity refuses one another tenant already uses
   → Required for all: name, slug, chatbot version, LLM provider, LLM API key,
     vector store (Pinecone | customer-cloud pgvector)
   → Pinecone only: the customer's own Pinecone API key
   → AWS extra: AWS account ID, region, deployment role ARN, optional S3 prefix,
     optional domain + ACM certificate ARN
   → Azure extra: subscription ID, tenant ID, deployment identity client ID, region
   → Optional: Test connection (verify-tenant-aws.yml / verify-tenant-azure.yml)

2. Server action createTenantAndDeploy (actions.ts) validates with Zod
   (the Pinecone key is required iff vectorStore = "pinecone"), then repeats the
   slug and identity checks — before anything reaches the customer's cloud

3. Encrypt LLM API key — and the Pinecone key, if any — for DB storage

4a. AWS path:
    → AssumeRole into customer account (15-min session), sending the tenant's
      sts:ExternalId — their trust policy conditions on it, so the role can only
      be assumed for this tenant (see src/lib/awsTrust.ts)
    → Write LLM secret to customer's Secrets Manager: {slug}/llm-api-key
    → If Pinecone: also write {slug}/pinecone-api-key
    → Generate and write {slug}/docs-signer-secret, keeping an encrypted copy
    → Store returned ARNs in tenant record

4b. Azure path:
    → No Azure call and no Azure credential: the tenant row is created under the
      wizard's tenant ID, which the customer's federated credential names
    → Generate the docs-signer secret and store it encrypted
    → LLM, Pinecone and docs-signer secrets are NOT written into the customer's
      cloud now — the deploy run fetches them and Terraform writes them

5. Insert tenant record (id = the wizard's tenant ID)

6. Insert deployment record (status: "pending")

7. Call GitHub workflow_dispatch via Octokit
   → AWS: deploy-tenant.yml
   → Azure: deploy-tenant-azure.yml

8. Update deployment status → "running"

9. The wizard's last step shows live progress in place (no redirect)
```

---

## Deployment Workflows

### AWS — `.github/workflows/deploy-tenant.yml`

**Required GitHub repo variable:**
- `AWS_PLATFORM_DEPLOY_ROLE_ARN` — the platform role GitHub Actions assumes through OIDC. No AWS access key is stored in GitHub; see [`infra/platform/github-oidc`](infra/platform/github-oidc) for the one-time setup and cutover

**Required GitHub repo secrets:**
- `PLATFORM_BASE_URL` (e.g. `https://platform.example.com`)
- `PLATFORM_WEBHOOK_SECRET`

**Workflow steps** (job environment `tenant-{tenant_id}`, 45-minute timeout):
1. POST `status: running` + run ID/URL to `/api/deployments/{id}/status` (best-effort — powers the live-progress panel)
2. Exchange GitHub's OIDC token for one-hour credentials on the platform role; pull **backend** and **frontend (chat UI)** images from platform ECR, logging in to the registry's own region
3. Drop those credentials and federate straight into the customer account's deployment role with a fresh GitHub OIDC token (`unset-current-credentials: true`, one-hour cap). The role trusts only this tenant's environment subject; the platform account is not a principal here
4. Create ECR repos in customer account if absent (`{slug}/chatbot`, `{slug}/chatbot-frontend`); tag and push both images, each push retried up to three times
5. Ensure the ECS service-linked role exists
6. `terraform init` through [`.github/scripts/terraform-init-aws.sh`](.github/scripts/terraform-init-aws.sh): state in the customer's own bucket `tfstate-{slug}-{account}-{region}-an`, checked to belong to the customer's account, and locked with an S3 lock file
7. For Pinecone tenants: read the customer's Pinecone key back from **their** Secrets Manager under the tenant role and `::add-mask::` it, so Terraform can create the index without the key ever being a workflow input
8. Install the docs-signer Lambda's dependencies; `terraform apply -auto-approve` — provisions all infra
9. Grant the docs-signer Function URL its invoke permission with the AWS CLI (the pinned provider cannot express it)
10. Read outputs: `alb_dns_name`, `chatbot_url`, `docs_signer_url`; upload them as the `deployment-outputs-{id}` artifact (90 days)
11. POST to `/api/deployments/{id}/status` with status + URLs + GitHub run details

### Azure — `.github/workflows/deploy-tenant-azure.yml`

**Workflow inputs (`workflow_dispatch`):** fully per-tenant, dispatched by `buildAzureInputs` in [`src/lib/deploy.ts`](src/lib/deploy.ts). GitHub's `workflow_dispatch` input limit was 10 when this was designed (raised to 25 in December 2025), so non-secret settings travel packed in one JSON input rather than as separate top-level inputs:

| Input | Contents |
|---|---|
| `deployment_id` | Platform deployment row UUID (status callbacks post to it) |
| `tenant_id` | Platform tenant row UUID. The job runs in GitHub environment `tenant-{tenant_id}`, which is the subject the customer's federated credential trusts |
| `tenant_slug` | Tenant identifier |
| `config` | JSON: `azure_subscription_id`, `azure_tenant_id`, `azure_client_id`, `azure_region`, `llm_provider`, `llm_model`, `chatbot_version`, `domain`, `vector_store`, `retrieval_min_score` — parsed by the workflow's "Parse tenant config" step (keep key names in sync with `buildAzureInputs`) |
| `your_ecr_image` | Source backend image URI in the platform's ECR, with tag — same golden image AWS deploys replicate |
| `your_frontend_ecr_image` | Source frontend (chat UI) image URI in the platform's ECR, with tag — same golden image AWS deploys replicate |

`your_ecr_image`/`your_frontend_ecr_image` are operator-level values, not per-tenant config, so — like AWS's `deploy-tenant.yml` — they travel as plain top-level inputs rather than packed into `config`.

**No secret is an input.** GitHub records dispatch inputs in the run's event payload, readable by anyone with read access to the repository. The run instead fetches the LLM key, the Pinecone key and the docs-signer secret from `POST /api/deployments/{id}/secrets`, proving with its own GitHub OIDC token that it is this tenant's deploy run. The platform releases them once per deployment (see "Credentials in Transit" in [`SECURITY.md`](SECURITY.md)).

**Required GitHub repo secrets:**
- Repo variable `AWS_PLATFORM_DEPLOY_ROLE_ARN` — the same OIDC-assumed platform role as the AWS workflow, used here only to pull the golden images. No AWS access key is stored in GitHub
- `PLATFORM_BASE_URL`, `PLATFORM_WEBHOOK_SECRET` (status callbacks and the secret fetch)

No Azure credential exists anywhere in this pipeline: not as a repo secret, not as an input, not in the platform database. The `AZURE_*`, `LLM_API_KEY`, and `PINECONE_API_KEY` repo secrets are no longer used — Azure login, Key Vault contents, and vector storage are all per-tenant now.

**Azure access (federation):** the job declares `environment: tenant-${{ inputs.tenant_id }}`, so GitHub's OIDC token carries `sub = repo:{owner}/{repo}:environment:tenant-{tenant_id}`. The customer's identity holds a federated credential for exactly that subject (issuer `https://token.actions.githubusercontent.com`, audience `api://AzureADTokenExchange`). `azure/login` and both Terraform providers, `azurerm` and `azapi` (`use_oidc = true`, `use_cli = false`), exchange the token for Entra access tokens. Environments on a private repository need GitHub Pro, Team or Enterprise; without them the login is refused and the run stops before creating anything. The platform's repository is public for this reason. See "Azure Security Model" in [`SECURITY.md`](SECURITY.md).

**Workflow steps** (45-minute timeout):
1. POST `status: running` + run ID/URL to `/api/deployments/{id}/status` (best-effort — powers the live-progress panel)
2. Fetch the tenant's secrets from the platform with the run's OIDC token; mask them and write them to a runner-temp file that only the Terraform steps source
3. Parse the `config` JSON into step outputs (jq)
4. Check out the platform repo
5. Compute resource names (ACR name, destination image URIs tagged with `chatbot_version`) and derive the source ECR registry/region from `your_ecr_image`
6. Pull the platform's golden **backend** and **frontend (chat UI)** images from the platform's ECR (platform role via OIDC — same images AWS deploys replicate)
7. Azure login into the **customer's subscription** through the tenant's federated credential (no secret); a refusal reports the exact subject the credential must trust
8. `terraform init` through [`.github/scripts/terraform-init-azure.sh`](.github/scripts/terraform-init-azure.sh): state in the customer's own storage account `cbtf{slug}` (container `tfstate`), found in the chatbot's resource group, reached through Entra ID with the run's OIDC token, locked with a blob lease
9. `terraform apply` (bootstrap, `-target` the ACR, the chatbot's user-assigned identity and its `AcrPull` grant) with placeholder image URIs; the resource group is read, never targeted
10. Wait 90 seconds for the `AcrPull` grant to propagate
11. `az acr login`, then retag and push both pulled images into the customer's ACR, each push retried up to three times
12. `terraform apply` (full) — provisions infra and writes the LLM key plus either the customer's Pinecone key or the generated pgvector connection URL to Key Vault (secrets passed via `TF_VAR_*` env, not argv)
13. Delete the secrets file from the runner
14. Read outputs; deploy the docs-signer Function code; upload the outputs artifact; POST `status: succeeded` with them (or `status: failed` on any failure) back to the platform

### Teardown and connection checks

- `destroy-tenant.yml` (AWS, 60 min) and `destroy-tenant-azure.yml` (Azure, 45 min) sign in exactly as a deploy does and run `terraform destroy`. The AWS run also empties the docs bucket, including object versions, and deletes the ECR repositories and the secrets onboarding wrote. The Azure run fetches only the Pinecone key, which destroying the index needs. Neither removes what the customer's setup created — the AWS stack and state bucket, or the Azure resource group, identity and state storage — and each run's summary says so.
- `verify-tenant-aws.yml` and `verify-tenant-azure.yml` (5 min) run in the tenant's environment, sign in as a deploy would, check the state storage (and, on Azure, the resource group) and stop. **Test connection** in the wizard and on the tenant page dispatches them; nothing about the result is stored.

---

## AWS Infrastructure

Defined in `infra/terraform/main.tf`. Everything is created in the **customer's** AWS account.

### Networking
- VPC `10.20.0.0/16` with DNS enabled
- 2 public subnets (`10.20.0.0/24`, `10.20.1.0/24`) across 2 AZs
- Internet Gateway + public route table
- With pgvector only: one private subnet per AZ in the region (`10.20.10.0/24` upward) for the database, with no route to the internet. Spanning every zone lets RDS place the instance wherever its class and storage type are available

> Note: Tasks run with public IPs in public subnets to avoid NAT Gateway cost. Suitable for MVP; revisit for production with private subnets + VPC endpoints.

### Load Balancer and HTTPS
- Application Load Balancer (idle timeout 180 s) with path-based routing:
  - **Default action** → frontend target group (IP mode, port 80, health check on `/`)
  - **Rule `/api/*`** (priority 10) → backend target group (IP mode, port 8000, health check on `/api/health`)
- A user hits one URL (`chatbot_url`); the ALB serves the UI from `/` and routes API calls to the backend, so the frontend needs no API proxy.
- **HTTPS, two routes:**
  - With `acm_certificate_arn` (and `domain`): an HTTPS listener on :443 (TLS 1.2/1.3), and :80 only redirects to it.
  - Without one, and with `enable_cdn` (the default): a CloudFront distribution in front of the ALB serves `https://<id>.cloudfront.net`. The CloudFront→ALB hop is plain HTTP, and the ALB still answers on :80. `PLATFORM_ENABLE_CDN=false` turns this off for accounts AWS has not verified for CloudFront, leaving plain HTTP.

### Compute
Two ECS Fargate services in one cluster (each desired count: 1):
- **Backend** (`chatbot-{slug}`) — container `chatbot`, image `{slug}/chatbot:{version}`; defaults 1024 CPU units / 2048 MB
  - Environment: `S3_DOCS_BUCKET`, `S3_DOCS_PREFIX`, `LLM_PROVIDER`, `AWS_REGION`, `PORT`, `OPENAI_BASE_URL`, `OPENAI_API_BASE`, `LLM_MODEL`, `VECTOR_STORE`, plus either `PINECONE_INDEX` (`chatbot-{slug}`) or `PGVECTOR_TABLE` / `PGVECTOR_DIMENSION`, plus `RETRIEVAL_MIN_SCORE` when the tenant overrides it
  - Secrets injected from Secrets Manager: `LLM_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` (all → LLM secret), plus either `PINECONE_API_KEY` (→ the customer's Pinecone secret) or `DATABASE_URL` / `PGVECTOR_URL` (→ the vector-db-url secret)
- **Frontend** (`chatbot-{slug}-frontend`) — container `frontend` (nginx :80), image `{slug}/chatbot-frontend:{version}`; defaults 256 CPU units / 512 MB

### Storage
- S3 bucket: `chatbot-{tenant_slug}-docs`
  - AES-256 server-side encryption
  - All public access blocked
  - Versioned; noncurrent versions expire after 30 days
  - CORS allows `POST` from `PLATFORM_BASE_URL` and, if set, `EXTRA_CORS_ORIGIN` — the only addresses browser uploads can come from
  - Bucket name is set in `S3_DOCS_BUCKET` env var at container startup
- Docs-signer Lambda `chatbot-{slug}-docs-signer` behind a Function URL: `s3:PutObject`/`s3:DeleteObject` on the prefix and nothing else (see `DOCUMENT-MANAGEMENT.md`)

### Vector store
Selected per tenant by `vector_store`; exactly one of the following is created.

**`pinecone`** — Pinecone serverless index `chatbot-{slug}` in the **customer's own** Pinecone project, created by Terraform (`pinecone_index.this`), dimension 384 / cosine, destroyed with the tenant (`deletion_protection = "disabled"`).

**`pgvector`** — RDS PostgreSQL 16 `chatbot-{slug}-vectors` inside the tenant's VPC:
- `db.t4g.micro`, 20 GB gp3, `storage_encrypted = true`, 1-day backups (storage and retention are both the most an AWS Free plan account allows)
- `publicly_accessible = false`; security group admits port 5432 from the chatbot task SG only
- Connection URL (with a Terraform-generated password) stored at `{slug}/vector-db-url` and injected as `DATABASE_URL`

### Secrets Manager
- **LLM key**: `{slug}/llm-api-key` — written by the platform during onboarding (see below)
- **Pinecone key** *(vector_store = pinecone)*: `{slug}/pinecone-api-key` — the customer's own key, written by the platform during onboarding via AssumeRole (same path as the LLM key)
- **Vector DB URL** *(vector_store = pgvector)*: `{slug}/vector-db-url` — created by Terraform, holds the full Postgres connection URL including a generated password

### IAM
- **Execution role**: `AmazonECSTaskExecutionRolePolicy` + `secretsmanager:GetSecretValue` on the LLM secret plus whichever vector-store secret the tenant uses
- **Task role**: `s3:ListBucket` on docs bucket, `s3:GetObject` on `{bucket}/{prefix}*`

### CloudWatch
- Log group `/ecs/chatbot-{slug}`, 14-day retention

### Terraform variables

| Variable | Required | Description |
|---|---|---|
| `tenant_slug` | yes | 3–21 chars, lowercase alphanumeric + hyphens |
| `aws_region` | yes | e.g. `us-east-1` |
| `image_uri` | yes | Full backend ECR URI with tag in customer account |
| `frontend_image_uri` | yes | Full frontend (chat UI) ECR URI with tag in customer account |
| `llm_provider` | yes | `openai`, `anthropic`, or `openrouter` |
| `llm_secret_arn` | yes | Secrets Manager ARN (written by platform during onboarding) |
| `llm_model` | no | Model override; empty string uses the per-provider default |
| `vector_store` | no | `pinecone` or `pgvector`; default `pinecone` |
| `pinecone_api_key` | no | Customer's Pinecone key (sensitive), read from their Secrets Manager by the workflow; only used to create the index |
| `pinecone_secret_arn` | no | ARN of the customer's Pinecone key secret, injected into the container |
| `pinecone_environment` | no | Pinecone serverless region for the tenant's index; default `us-east-1`. **Never set by the platform** — see Known Limitation #6 in SECURITY.md |
| `vector_db_instance_class` | no | RDS class for pgvector; default `db.t4g.micro` |
| `vector_db_storage_gb` | no | RDS storage for pgvector; default `20` |
| `s3_docs_prefix` | no | Optional prefix scope within docs bucket |
| `retrieval_min_score` | no | Cosine-similarity floor for retrieved chunks. Empty (the default) leaves the container's own 0.15. Set too high, the chatbot answers everything with "I don't have enough information" — see CHATBOT-LOGIC.md |
| `domain` | no | Custom hostname |
| `acm_certificate_arn` | no | ACM certificate for `domain`; enables the HTTPS listener |
| `enable_cdn` | no | Front a certificate-less tenant with CloudFront; default `true` |
| `docs_signer_secret_arn` | yes | ARN of the docs-signer's secret, written at onboarding |
| `platform_origin` | yes | `PLATFORM_BASE_URL`; the docs bucket's CORS origin |
| `extra_cors_origin` | no | A second CORS origin, from the `EXTRA_CORS_ORIGIN` repository variable |
| `max_docs_upload_mb` | no | Upload size limit the presigned POST enforces; default 25 |
| `container_port` | no | Backend port, default: 8000 |
| `frontend_port` | no | Frontend port, default: 80 |
| `task_cpu` / `task_memory` | no | Backend Fargate sizing (default 1024 / 2048) |
| `frontend_cpu` / `frontend_memory` | no | Frontend Fargate sizing (default 256 / 512) |

---

## Azure Infrastructure

Defined in `infra/terraform/azure/main.tf`. Everything is created in the **customer's** Azure subscription, inside the resource group their setup deployment created (`infra/bootstrap/azure/tenant-bootstrap.json`). That setup also created the deployment identity `chatbot-deploy-{slug}`, its federated credential, its two roles on the group, and the state storage account `cbtf{slug}`; Terraform manages none of them.

### Resources created

| Resource | Name pattern | Notes |
|---|---|---|
| Resource Group | `chatbot-{slug}` | Created by the customer's setup; Terraform only reads it (`data "azurerm_resource_group"`) |
| Container Registry | `chatbot{slug}` | Basic SKU, admin user disabled — images are pulled by the chatbot's user-assigned identity holding `AcrPull` (name: hyphens stripped, 50-char max) |
| Key Vault | `cb-{slug}-kv` | Standard SKU; stores `llm-api-key`, `docs-signer-secret`, and either `pinecone-api-key` or `vector-db-url` (all written by Terraform). The storage account key is deliberately not stored, and the docs account refuses Shared Key authorization: both containers reach Blob Storage through managed identities instead |
| PostgreSQL Flexible Server | `chatbot-{slug}-pg` | Only when `vector_store = pgvector`; B1ms / 32 GB / PG 16, `azure.extensions = VECTOR`, database `vectors` |
| Storage Account | `chatbot{slug}` | Hyphens removed; 24-char max enforced. Shared Key authorization disabled; CORS allows `PUT` from `PLATFORM_BASE_URL` and, if set, `EXTRA_CORS_ORIGIN` |
| Blob container | `documents` | Private access; 30-day soft delete |
| Function App | `chatbot-{slug}-docs-signer` | The docs-signer (Linux Consumption, Node 20), with a system-assigned identity holding write and delete, never read, on the docs account; its own runtime storage account `chatbot{slug}fn` |
| Log Analytics Workspace | `chatbot-{slug}-logs` | 30-day retention (PerGB2018 SKU) |
| Container App Environment | `chatbot-{slug}-cae` | Linked to Log Analytics; `environmentMode = WorkloadProfiles` with the Consumption profile only, declared through the `azapi` provider because azurerm cannot set the mode and Azure's default produced an Express environment, which refuses the frontend sidecar |
| Container App | `chatbot-{slug}` | Single revision mode; two containers (backend + frontend) |

### Container App config
- Min 1 replica, max 3 (autoscaling), on the environment's Consumption workload profile
- Each deploy sets `revision_suffix = r{run_id}-{attempt}`, forcing a new revision that re-pulls the mutable image tag
- Container App secrets: `llm-api-key`, plus `pinecone-api-key` or `vector-db-url` depending on `vector_store`
- Container App identity: user-assigned `chatbot-{slug}-chatbot-id`, created in the bootstrap apply, holding `AcrPull` on the registry and a custom role on the docs storage account granting `containers/read` and `blobs/read` only — separate from the docs-signer's write-and-delete identity. The registry's admin user is disabled; images are pulled with this identity, and `AZURE_CLIENT_ID` tells the backend's `DefaultAzureCredential` which identity to use
- **Two containers in one app** (Container Apps has no path-based ingress routing, so both share localhost):
  - `chatbot` (backend, 0.5 vCPU / 1 Gi) — env `PORT`, `LLM_PROVIDER`, `AZURE_STORAGE_ACCOUNT`, `AZURE_STORAGE_CONTAINER`, `VECTOR_STORE`, `OPENAI_BASE_URL`, `OPENAI_API_BASE`, `LLM_MODEL`, plus `PINECONE_INDEX` / `PINECONE_ENVIRONMENT` or `PGVECTOR_TABLE` / `PGVECTOR_DIMENSION`; secret-backed env `LLM_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` (← `llm-api-key`), plus `PINECONE_API_KEY` (← `pinecone-api-key`) or `DATABASE_URL` / `PGVECTOR_URL` (← `vector-db-url`)
  - `frontend` (chat UI, nginx :80, 0.25 vCPU / 0.5 Gi) — env `BACKEND_PORT`; nginx serves the SPA and proxies `/api` → `localhost:8000`
- External ingress on **target port 80** → frontend container

### Terraform variables

| Variable | Required | Notes |
|---|---|---|
| `tenant_slug` | yes | Max 18 chars (Key Vault naming limit) |
| `azure_subscription_id`, `azure_tenant_id`, `azure_client_id` | yes | Customer deployment identity, all validated as UUIDs. No secret: the provider authenticates with OIDC |
| `azure_region` | yes | e.g. `eastus` (default `eastus`) |
| `image_uri` | yes | Full backend ACR image URI with tag |
| `frontend_image_uri` | yes | Full frontend (chat UI) ACR image URI with tag |
| `llm_provider` | yes | `openai`, `anthropic`, or `openrouter` |
| `llm_api_key` | yes | Plain text (sensitive); Terraform writes to Key Vault |
| `vector_store` | no | `pinecone` or `pgvector`; default `pinecone` |
| `pinecone_api_key` | no | Customer's Pinecone key (sensitive); Terraform writes it to Key Vault and uses it to provision the tenant's index |
| `pinecone_environment` | no | Pinecone serverless region for the tenant's index; default `us-east-1`. **Never set by the platform** — see Known Limitation #6 in SECURITY.md |
| `vector_db_sku` | no | Flexible Server SKU for pgvector; default `B_Standard_B1ms` |
| `vector_db_storage_mb` | no | Flexible Server storage for pgvector; default `32768` |
| `llm_model` | no | Model override; empty string uses the per-provider default |
| `docs_signer_secret` | yes | Plain text (sensitive); set as the Function App's `DOCS_SIGNER_SECRET` and written to Key Vault |
| `platform_origin` | yes | `PLATFORM_BASE_URL`; the docs storage's CORS origin |
| `extra_cors_origin` | no | A second CORS origin, from the `EXTRA_CORS_ORIGIN` repository variable |
| `revision_suffix` | no | Set per run by the workflow, so every deploy creates a new revision |
| `retrieval_min_score` | no | Cosine-similarity floor for retrieved chunks; empty leaves the container default |
| `docs_prefix`, `max_docs_upload_mb` | no | The signer's object prefix, and its upload size limit (default 25) |
| `domain` | no | Custom hostname. Reported as the URL but not bound — see `LIMITATIONS.md` #27 |
| `container_port` | no | Backend port, default: 8000 |
| `frontend_port` | no | Frontend port, default: 80 |

---

## Secret & Credential Handling

### LLM API key

**AWS:**
1. Received from form
2. Platform calls `assumeTenantRole` → assumes customer's IAM role, sending the tenant's `sts:ExternalId`
3. `writeTenantSecret` stores key in customer's Secrets Manager as `{slug}/llm-api-key` (and `{slug}/pinecone-api-key` for Pinecone tenants)
4. ARN stored in `tenants.llmSecretArn`
5. ECS execution role reads it at task startup — key never touches platform disk after onboarding

**Azure:**
1. Received from form
2. Encrypted with AES-256-GCM, stored in `tenants.llmApiKeyEncrypted`
3. Decrypted only when the deploy run fetches it from `/api/deployments/{id}/secrets` with an OIDC token for this tenant's environment (once per deployment; see `src/lib/deploymentSecrets.ts`)
4. Passed to Terraform as a variable; Terraform writes it to Key Vault and sets it as a Container App secret
5. The container reads it from that Container App secret; Key Vault holds a durable copy the customer can see and rotate

### Cloud access
- **AWS:** no credential is stored. The customer's setup stack creates a role that trusts GitHub's OIDC token for subject `repo:{owner}/{repo}:environment:tenant-{tenant id}`, used by every deploy, teardown and connection check, and the platform's account for onboarding only, conditioned on `sts:ExternalId` = the tenant ID ([`src/lib/awsTrust.ts`](src/lib/awsTrust.ts)). The platform's own AWS identity comes from the operator's `aws login` session, or from `PLATFORM_AWS_ROLE_ARN` on a host that signs its own OIDC token.
- **Azure:** no credential is received, stored or transmitted. The customer's setup deployment creates a managed identity with a federated credential trusting the same subject, built in [`src/lib/azureFederation.ts`](src/lib/azureFederation.ts) and [`src/lib/bootstrapLinks.ts`](src/lib/bootstrapLinks.ts).
- The customer revokes the platform by deleting the setup stack (AWS), or the federated credential or resource group (Azure)

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
AUTH_ALLOWED_EMAILS=            # optional; unset means any GitHub account may sign in

# ── GitHub (trigger workflows) ────────────────────────────────────────
GITHUB_PAT=                     # Personal Access Token: repo + workflow scopes
CHATBOT_REPO_OWNER=             # GitHub username/org that owns the repo
CHATBOT_REPO_NAME=ai-chatbot-platform
CHATBOT_DEPLOY_WORKFLOW=deploy-tenant.yml     # AWS; overridable
CHATBOT_DESTROY_WORKFLOW=destroy-tenant.yml   # AWS; the Azure workflows are fixed
CHATBOT_DEPLOY_REF=main                       # branch/tag workflows run from

# ── Webhook security ──────────────────────────────────────────────────
DEPLOY_WEBHOOK_SECRET=          # shared with GitHub Actions PLATFORM_WEBHOOK_SECRET

# ── Customer setup (one-click bootstrap) ──────────────────────────────
PLATFORM_BOOTSTRAP_TEMPLATE_BASE_URL=   # where infra/platform/bootstrap-templates published the templates
PLATFORM_AWS_ACCOUNT_ID=                # the principal the AWS onboarding trust statement names

# ── Encryption ────────────────────────────────────────────────────────
PLATFORM_ENCRYPTION_KEY=        # openssl rand -hex 32

# ── AWS (platform's own principal) ────────────────────────────────────
# Used by this application only, for onboarding's sts:AssumeRole into the
# customer's role. No key: the profile assumes the role in
# infra/platform/control-plane from `aws login --profile platform-operator`,
# and the application refuses long-lived keys. GitHub Actions reaches its own
# platform role through OIDC (see infra/platform/github-oidc).
AWS_PROFILE=platform-control-plane
PLATFORM_AWS_ROLE_ARN=          # instead of AWS_PROFILE on a host that signs its own OIDC token
PLATFORM_ENABLE_CDN=            # false for accounts AWS has not verified for CloudFront; those tenants get plain HTTP

# ── Chatbot images (replicated into each tenant's own registry — ECR for AWS, ACR for Azure) ──
PLATFORM_CHATBOT_IMAGE_URI=     # backend ECR URI without tag, e.g.:
                                # 123456789012.dkr.ecr.us-east-1.amazonaws.com/chatbot
PLATFORM_FRONTEND_IMAGE_URI=    # frontend (chat UI) ECR URI without tag, e.g.:
                                # 123456789012.dkr.ecr.us-east-1.amazonaws.com/chatbot-frontend

# ── Optional ──────────────────────────────────────────────────────────
DEMO_CHATBOT_URL=               # adds a "Demo chatbot" button to the dashboard
```

GitHub-side settings, which live in the repository rather than this file: the secrets `PLATFORM_BASE_URL` and `PLATFORM_WEBHOOK_SECRET`, and the variables `AWS_PLATFORM_DEPLOY_ROLE_ARN` and (optionally) `EXTRA_CORS_ORIGIN`.

---

## AWS vs. Azure Comparison

| Aspect | AWS | Azure |
|---|---|---|
| Compute | ECS Fargate (2 services: backend + frontend) | Container Apps (1 app, 2 containers) |
| UI routing | ALB path routing: `/api/*` → backend, `/` → frontend | nginx in frontend proxies `/api` → backend over localhost |
| Image source | Replicated prebuilt from platform ECR (backend + frontend), pushed to ECR | Replicated prebuilt from platform ECR (backend + frontend), pushed to ACR |
| LLM secret store | Secrets Manager (pre-created during onboarding) | Key Vault (created by Terraform during deploy) |
| LLM key flow | Written by platform → ARN stored → injected by ECS execution role | Encrypted in DB → passed to Terraform → written to Key Vault |
| Docs storage | S3 bucket `chatbot-{slug}-docs` | Blob container `documents` in Storage Account |
| Auth model | Deploys: GitHub OIDC federation into the customer's role, per-tenant environment subject. Onboarding only: STS AssumeRole with a per-tenant `sts:ExternalId`. Nothing stored | Workload identity federation, per-tenant GitHub environment subject; nothing stored |
| Network | Public subnets, ALB, public IPs | Container Apps managed networking |
| Terraform state | Customer's own bucket `tfstate-{slug}-{account}-{region}-an`, key `terraform.tfstate`, S3 lock file | Customer's own storage account `cbtf{slug}`, container `tfstate`, Entra ID only, blob lease |
| Slug max length | 21 chars (the frontend target group name, `chatbot-{slug}-ui`, is capped at 32) | 18 chars (Key Vault name constraint) |
| Autoscaling | Fixed 1 replica (ECS desired_count) | 1–3 replicas (Container Apps) |

---

## File Structure

```
src/
  app/
    api/
      auth/[...nextauth]/route.ts        # NextAuth handlers
      deployments/[id]/status/route.ts   # Workflow callback webhook
      deployments/[id]/secrets/route.ts  # Azure runs fetch their secrets here, with an OIDC token
      deployments/[id]/progress/route.ts # Live progress and lost-webhook reconciliation
    (dashboard)/                         # Dashboard, chatbots, activity, issues, in-app guides
    tenants/
      new/
        page.tsx                         # Onboarding wizard page
        TenantForm.tsx                   # Wizard UI (client component)
        wizard/                          # Steps, setup panels, slug/identity checks as you type
        actions.ts                       # Server actions: checks, create + deploy, drafts
      [id]/
        page.tsx                         # Tenant detail
        documents/                       # Upload, delete, reindex (see DOCUMENT-MANAGEMENT.md)
    signin/page.tsx                      # Sign-in page
  auth.ts                                # NextAuth config
  proxy.ts                               # Route auth guard (Next 16's renamed middleware)
  db/
    index.ts                             # Drizzle + Neon setup
    schema.ts                            # All table definitions and relations
  lib/
    aws.ts                               # Platform AWS identity, assumeTenantRole, writeTenantSecret
    awsTrust.ts                          # Per-tenant ExternalId and the trust policy the wizard shows
    azure.ts                             # generateDocsSignerSecret (no Azure API calls)
    azureFederation.ts, githubOidc.ts    # The per-tenant OIDC subject both clouds trust
    bootstrapLinks.ts                    # One-click setup links and commands, both clouds
    resourceNames.ts, nameAvailability.ts # Derived global names; collision and DNS/S3 checks
    verifyConnection.ts, connectionCheck.ts # Test connection, and sign-in errors explained
    deploy.ts                            # triggerDeployment, triggerTenantDestroy, dispatch inputs
    deploymentSecrets.ts                 # The one-time secret release to an Azure run
    reconcile.ts                         # Recovers a run's outcome when its webhook is lost
    docsSigner.ts, reindex.ts            # Document operations and reindexing
    tenantErasure.ts                     # Erases a deleted tenant's secrets
    crypto.ts, operators.ts, pricing.ts, tenantInput.ts, github.ts

infra/
  bootstrap/aws/tenant-bootstrap.yaml    # Customer setup (CloudFormation): role, GitHub trust, state bucket
  bootstrap/azure/tenant-bootstrap.json  # Customer setup (ARM): resource group, identity, federated credential, state storage
  platform/
    github-oidc/                         # Platform role GitHub Actions reaches through OIDC (image pulls only)
    control-plane/                       # Platform role the application assumes (onboarding only)
    bootstrap-templates/                 # Public bucket the setup templates are published to
  terraform/                             # AWS tenant: VPC, ALB, CloudFront, ECS, S3, Lambda, IAM, RDS/Pinecone
  terraform/azure/                       # Azure tenant: ACR, Key Vault, storage, Function App, Container Apps, Postgres/Pinecone
  lambda/docs-signer/                    # AWS docs-signer
  azure-functions/docs-signer/           # Azure docs-signer

.github/
  workflows/
    deploy-tenant.yml, deploy-tenant-azure.yml    # Deploys
    destroy-tenant.yml, destroy-tenant-azure.yml  # Teardowns
    verify-tenant-aws.yml, verify-tenant-azure.yml # Test connection
  scripts/                               # terraform-init per cloud, docs bucket emptying

scripts/                                 # Operator scripts: reconcile or fail stuck deployments,
                                         # update a tenant's LLM settings or Azure identity,
                                         # test a docs-signer, backfill Azure outputs.
                                         # allow-local-cors.ts no longer works (it needs the
                                         # storage account key, now disabled); set
                                         # EXTRA_CORS_ORIGIN and redeploy instead
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
| **Secrets Manager** | 2 secrets (LLM + Pinecone) / 1 secret (pgvector) | ~$0.40–0.80 |
| **S3 — docs bucket** | Storage + requests (usage-based) | ~$0.50–5 |
| **CloudWatch Logs** | 14-day retention, low traffic | ~$1–3 |
| **RDS PostgreSQL + pgvector** | `db.t4g.micro` + 20 GB gp3 — **only if `vector_store = pgvector`** | ~$14 |
| **Data transfer** | Outbound to internet ($0.09/GB) | variable |
| **Total — `vector_store = pinecone`** | | **~$66–77/month** |
| **Total — `vector_store = pgvector`** | | **~$80–91/month** |

> The backend default was raised to 1 vCPU / 2 GB (`task_cpu = 1024`, `task_memory = 2048`) because the embedding model needs the memory headroom — see the note in CHATBOT-LOGIC.md. Drop it to `256 / 512` for a lighter (~$38–50/month) footprint if your backend image doesn't load a local model.
>
> **Choosing a vector store.** With `pinecone`, the customer pays Pinecone directly (serverless free tier covers light usage) and the ~$14 RDS line disappears — but embeddings leave their cloud account, and their own Pinecone plan's index-per-project quota (Starter 5, Builder 10, Standard 20, Enterprise 200) limits how many chatbots they can run. With `pgvector`, everything stays inside their account at a fixed ~$14/month.

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

> Per unit of compute, Azure Container Apps costs more than AWS Fargate at always-on usage; the AWS load balancer's fixed cost is what brings the two totals level. The environment is a workload-profiles environment with only the Consumption profile, billed exactly like consumption-only, free grant included — the management fee applies only to Dedicated profiles, and none is declared.

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

Combining infrastructure at the default sizing (Pinecone tenant, figures above) with LLM usage at 5,000 queries/month:

| | AWS | Azure |
|---|---|---|
| Infrastructure | ~$66–77/month | ~$66–75/month |
| LLM (GPT-4o mini) | ~$2/month | ~$2/month |
| LLM (GPT-4o) | ~$34/month | ~$34/month |
| **Total (GPT-4o mini)** | **~$68–79/month** | **~$68–77/month** |
| **Total (GPT-4o)** | **~$100–111/month** | **~$100–109/month** |

A pgvector tenant adds about $14 (AWS) or $17 (Azure). Azure's figures are before the Container Apps free grant, about $5.40/month per subscription.

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
