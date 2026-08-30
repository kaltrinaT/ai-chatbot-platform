# Architecture

## Control Plane / Data Plane Boundary

This platform is a **control plane only**. It deploys and monitors infrastructure. It has no access to the data plane.

```
┌─────────────────────────────────────────────────────────────────────┐
│                     CONTROL PLANE (this platform)                   │
│                                                                     │
│  Knows: tenant config, deployment status, chatbot URL               │
│  Does not know: queries, answers, documents, embeddings, logs       │
└────────────────────────────────┬────────────────────────────────────┘
                                 │ deploy + status callback only
                                 ▼
┌─────────────────────────────────────────────────────────────────────┐
│                  DATA PLANE (customer cloud account)                │
│                                                                     │
│  Chatbot runtime, S3/blob documents, LLM calls,                     │
│  CloudWatch/Log Analytics, user queries and answers                 │
│                                                                     │
│  ← platform never reads or receives any of this →                  │
└─────────────────────────────────────────────────────────────────────┘
```

The only information that crosses from data plane to control plane is deployment lifecycle data: success/failure status and the resulting chatbot URL. Do not add any endpoint, IAM role, or delegated access that would give the platform visibility into runtime traffic, documents, or logs.

**Document management (AWS) is the one deliberate, narrow exception to "no IAM role" above, and it's built specifically to avoid becoming a visibility exception too.** The platform lets an operator upload/delete a tenant's knowledge-base documents from its own UI, but it holds **no AWS credential of any kind** for the docs bucket — not even a scoped one. Instead, each tenant gets its own `docs-signer` Lambda (see the AWS Infrastructure diagram below), with an IAM role limited to `s3:PutObject`/`s3:DeleteObject` and nothing else — never `GetObject`, never `ListBucket`. The platform reaches it only over plain authenticated HTTPS (a shared secret, no AWS SigV4), the same shape as the existing deployment-status webhook. Uploads are S3 presigned POSTs the browser sends directly to S3 — file bytes never pass through the platform's server. The platform's own Postgres (`tenant_documents`), not `s3:ListBucket`, is what the document list in the UI is drawn from — so the platform knows filenames and sizes (it needs to, to render a list), but at no point holds a credential capable of reading a document's content. Deleting a document does not purge its already-embedded vectors — that's a limitation of the chatbot backend's `/api/index`, not something the platform can address.

### Configurable vector store

Where a tenant's embeddings live is a **per-tenant choice** made at onboarding
(`tenants.vector_store`), because isolation and cost pull in opposite
directions. Both options keep the platform out of the data path — the platform
holds no standing credential to either one after deployment.

| Client selection | AWS deployment | Azure deployment |
|---|---|---|
| Customer-owned Pinecone | Pinecone (customer's project) | Pinecone (customer's project) |
| Customer-cloud vector store | RDS PostgreSQL + pgvector | Azure Database for PostgreSQL + pgvector |

**`pinecone`** — the customer supplies their own Pinecone API key, handled
exactly like the LLM key: AES-256-GCM encrypted at rest, and on AWS written
into *their* Secrets Manager during onboarding so it never passes through
GitHub Actions. Terraform provisions one dedicated index (`chatbot-{slug}`)
inside the customer's project. Cheapest option and nothing to operate, but
embeddings leave the customer's cloud account for a third-party service.

**`pgvector`** — Terraform provisions a managed PostgreSQL instance with the
pgvector extension *inside the customer's own account*, on the same private
network as the chatbot. Embeddings sit beside the documents they were derived
from, so nothing crosses the data-plane boundary; the trade-off is roughly
$16–17/month for the smallest instance, plus a database to operate.

Neither option gives the platform access to embeddings. The residual risk is
the one already documented for every tenant secret: the platform operator holds
`PLATFORM_ENCRYPTION_KEY` and the database, so an encrypted credential *could*
be recovered — see Known Limitation #2 in `SECURITY.md`.

> **Residency caveat.** Only `pgvector` currently gives regional control. The
> platform never sets `pinecone_environment`, so every Pinecone index is created
> in the Terraform default `us-east-1` on AWS — including for a tenant deployed
> to `eu-central-1` or to Azure `westeurope`. A customer who picks Pinecone for
> a GDPR-motivated deployment still has their embeddings stored in Virginia.
> See Known Limitation #6 in `SECURITY.md`.

---

## System Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                        PLATFORM (this app)                          │
│                                                                     │
│   Browser ──► Next.js App Router                                    │
│                    │                                                │
│                    ├── NextAuth (GitHub OAuth)                      │
│                    ├── Server Actions                               │
│                    ├── Drizzle ORM ──────────────► Neon Postgres    │
│                    ├── AWS SDK (STS + Secrets Manager)              │
│                    ├── Azure SDK (Key Vault)                        │
│                    └── Octokit ──────────────────► GitHub Actions   │
│                                                         │           │
└─────────────────────────────────────────────────────────┼───────────┘
                                                          │
                              ┌───────────────────────────┘
                              │  workflow_dispatch
                              ▼
              ┌──────────────────────────────────────────┐
              │              GitHub Actions              │
              │                                          │
              │  deploy-tenant.yml (AWS):                │
              │    1. Pull image from platform ECR       │
              │    2. Replicate to customer ECR          │
              │    3. terraform apply                    │
              │                                          │
              │  deploy-tenant-azure.yml (Azure):        │
              │    1. Build images from source           │
              │    2. Push to customer ACR               │
              │    3. terraform apply                    │
              │                                          │
              │  Both: POST /api/deployments/{id}/       │
              │        status  (running, then final)     │
              └───────────┬──────────────────────────────┘
                          │
          ┌───────────────┴──────────────┬──────────────────────┐
          │                              │                      │
          ▼                              ▼                      ▼
┌──────────────────┐           ┌──────────────────┐  ┌─────────────────────┐
│  CUSTOMER AWS    │           │  CUSTOMER AZURE  │  │  CUSTOMER'S OWN     │
│  ACCOUNT         │           │  SUBSCRIPTION    │  │  PINECONE PROJECT   │
│                  │           │                  │  │                     │
│  VPC + subnets   │           │  Resource Group  │  │  only when the      │
│  ALB             │           │  Container App   │  │  tenant selects     │
│  ECS Fargate     │           │  ACR             │  │  vector_store =     │
│  ECR             │           │  Key Vault       │  │  "pinecone"         │
│  S3 docs bucket  │           │  Storage Account │  │                     │
│  Secrets Manager │           │  Log Analytics   │  │  index per tenant:  │
│  CloudWatch      │           │                  │  │  chatbot-{slug}     │
│                  │           │                  │  │                     │
│  vector_store =  │           │  vector_store =  │  │  billed to the      │
│  "pgvector"? →   │           │  "pgvector"? →   │  │  customer's own     │
│  RDS + pgvector  │           │  Azure PG +      │  │  Pinecone account   │
│                  │           │  pgvector        │  │                     │
└──────────────────┘           └──────────────────┘  └─────────────────────┘
```

---

## Tenant Onboarding & Deployment Flow

```
Operator                Platform (Next.js)           Customer Cloud      GitHub Actions
   │                          │                            │                    │
   │── POST /tenants/new ────►│                            │                    │
   │   (form data)            │                            │                    │
   │                          │ validate (Zod)             │                    │
   │                          │                            │                    │
   │                   ┌──────┴───────┐                    │                    │
   │              AWS  │              │ Azure               │                    │
   │                   │              │                     │                    │
   │              STS AssumeRole      │ encrypt             │                    │
   │              write LLM secret    │ azure_client_secret │                    │
   │              to Secrets Manager  │ store in DB         │                    │
   │              store ARN in DB     │                     │                    │
   │                   └──────┬───────┘                     │                    │
   │                          │                            │                    │
   │                          │ INSERT tenant              │                    │
   │                          │ INSERT deployment          │                    │
   │                          │   (status: pending)        │                    │
   │                          │                            │                    │
   │                          │── workflow_dispatch ───────────────────────────►│
   │                          │                            │                    │
   │                          │ UPDATE deployment          │                    │
   │                          │   (status: running)        │                    │
   │                          │                            │                    │
   │◄─ redirect /tenants/{id}─│                            │  pull ECR image    │
   │                          │                            │◄───────────────────│
   │                          │                            │  push to customer  │
   │                          │                            │  registry          │
   │                          │                            │  terraform apply   │
   │                          │                            │◄───────────────────│
   │                          │                            │  (infra created)   │
   │                          │                            │                    │
   │                          │◄── POST /api/deployments/  │────────────────────│
   │                          │         {id}/status        │  callback          │
   │                          │                            │                    │
   │                          │ UPDATE deployment          │                    │
   │                          │   (status: succeeded)      │                    │
   │                          │ UPDATE tenant              │                    │
   │                          │   (chatbotUrl, albDnsName) │                    │
   │                          │                            │                    │
   │── GET /tenants/{id} ────►│                            │                    │
   │◄─ chatbot URL ───────────│                            │                    │
```

Before submitting, the onboarding form and the tenant page render a **static
monthly cost estimate** for the resources that will run in the customer's own
cloud account (`src/lib/pricing.ts`, `CostEstimateCard`). These are list-price
estimates computed from the Terraform sizing defaults — the platform makes no
billing API calls and never sees actual customer spend.

---

## AWS Infrastructure (per tenant)

```
CUSTOMER AWS ACCOUNT
─────────────────────────────────────────────────────────────
VPC  10.20.0.0/16
│
├── Internet Gateway
│
├── Public Subnet A  10.20.0.0/24  (AZ-0)
│   └── ECS Fargate task (public IP)
│
├── Public Subnet B  10.20.1.0/24  (AZ-1)
│   └── ECS Fargate task (public IP)
│
├── Security Group: alb
│   └── ingress 0.0.0.0/0 → port 80
│
├── Security Group: task
│   └── ingress alb-sg → frontend_port (80)  + container_port (8000)
│       egress  all
│
├── Application Load Balancer
│   └── Listener :80
│         ├── default action        → Frontend Target Group (IP, port 80)
│         │     └── Health check GET /  matcher 200-399
│         └── rule /api/*  (prio 10) → Backend  Target Group (IP, port 8000)
│               └── Health check GET /api/health  matcher 200-399
│
├── ECS Cluster
│   ├── Backend Service (desired 1, Fargate, public IP)
│   │   └── Task Definition  (chatbot-{slug})
│   │       ├── Execution Role
│   │       │   ├── AmazonECSTaskExecutionRolePolicy
│   │       │   └── secretsmanager:GetSecretValue → LLM secret ARN
│   │       ├── Task Role
│   │       │   ├── s3:ListBucket → docs bucket
│   │       │   └── s3:GetObject  → docs bucket/{prefix}*
│   │       └── Container: chatbot
│   │           ├── image: {customer-ecr}/{slug}/chatbot:{version}
│   │           ├── env:   S3_DOCS_BUCKET, S3_DOCS_PREFIX,
│   │           │          LLM_PROVIDER, AWS_REGION, PORT,
│   │           │          OPENAI_BASE_URL, OPENAI_API_BASE,
│   │           │          LLM_MODEL, PINECONE_INDEX (=chatbot-{slug})
│   │           └── secret: LLM_API_KEY, OPENAI_API_KEY,
│   │                       ANTHROPIC_API_KEY ← LLM secret,
│   │                       PINECONE_API_KEY  ← Pinecone secret
│   │
│   └── Frontend Service (desired 1, Fargate, public IP)
│       └── Task Definition  (chatbot-{slug}-frontend)
│           ├── Execution Role (shared) — pulls image from customer ECR
│           └── Container: frontend  (chat UI, nginx :80)
│               └── image: {customer-ecr}/{slug}/chatbot-frontend:{version}
│
├── S3 Bucket: chatbot-{slug}-docs
│   ├── AES-256 SSE
│   ├── all public access blocked
│   └── CORS: POST from the platform's own origin (browser → S3 uploads)
│
├── Lambda: chatbot-{slug}-docs-signer  (Function URL, auth: NONE)
│   ├── Role: s3:PutObject + s3:DeleteObject → docs bucket/{prefix}*  ONLY
│   │         (never s3:GetObject, never s3:ListBucket)
│   ├── Role: secretsmanager:GetSecretValue → docs-signer-secret ARN only
│   └── The platform calls this over plain HTTPS (shared-secret header) to
│       mint presigned S3 POSTs for uploads and to perform deletes. This is
│       the ONLY way the platform ever touches this bucket — it holds no AWS
│       credential capable of reading, writing, or listing it. See the
│       Control Plane / Data Plane Boundary section above.
│
├── Secrets Manager: {slug}/llm-api-key
│   └── written by platform during onboarding (AssumeRole)
│
├── Secrets Manager: {slug}/docs-signer-secret
│   └── shared auth secret for the docs-signer Lambda above, generated and
│       written by the platform during onboarding (AssumeRole) — the
│       platform also keeps its own encrypted copy so it never needs to
│       touch tenant AWS again to use it; only the ARN travels through
│       Terraform/GitHub Actions afterward, like llm-api-key
│
├── Secrets Manager: {slug}/pinecone-api-key      [vector_store = pinecone]
│   └── the CUSTOMER's own key, written by the platform during onboarding
│       (AssumeRole) — never passed to GitHub Actions; only the ARN is
│
├── RDS PostgreSQL 16: chatbot-{slug}-vectors     [vector_store = pgvector]
│   ├── db.t4g.micro, 32 GB gp3, storage encrypted, 7-day backups
│   ├── publicly_accessible = false, in the tenant's own subnet group
│   ├── Security Group: vectors  (ingress 5432 from task-sg ONLY)
│   └── Secrets Manager: {slug}/vector-db-url
│         └── postgresql://… connection URL incl. generated password
│
└── CloudWatch Log Group: /ecs/chatbot-{slug}  (14-day retention)

CUSTOMER'S OWN PINECONE PROJECT                  [vector_store = pinecone]
─────────────────────────────────────────────────────────────
└── Serverless index: chatbot-{slug}   (dim 384, cosine, us-east-1)
    └── created by the same terraform apply. The workflow reads the
        customer's key from THEIR Secrets Manager under the assumed role,
        masks it, and passes it to the pinecone provider via TF_VAR.

Terraform state: s3://{TF_STATE_BUCKET}/tenants/{slug}.tfstate
```

---

## Azure Infrastructure (per tenant)

```
CUSTOMER AZURE SUBSCRIPTION
─────────────────────────────────────────────────────────────
Resource Group: chatbot-{slug}
│
├── Container Registry: chatbot{slug}acr  (Basic SKU, admin enabled)
│   │  images are BUILT FROM SOURCE in deploy-tenant-azure.yml and pushed
│   │  here (AWS instead replicates prebuilt images from the platform ECR)
│   ├── image: chatbot{slug}acr.azurecr.io/chatbot-backend:{version}
│   └── image: chatbot{slug}acr.azurecr.io/chatbot-frontend:{version}
│
├── Key Vault: cb-{slug}-kv  (Standard SKU)
│   ├── secret: llm-api-key       ← written by Terraform during apply
│   ├── secret: pinecone-api-key  ← customer's own key  [vector_store = pinecone]
│   ├── secret: vector-db-url     ← Postgres URL        [vector_store = pgvector]
│   └── secret: storage-key       ← storage account primary access key
│
├── PostgreSQL Flexible Server: chatbot-{slug}-pg  [vector_store = pgvector]
│   ├── B_Standard_B1ms, 32 GB, PG 16, 7-day backups
│   ├── azure.extensions = VECTOR  (allows CREATE EXTENSION vector)
│   ├── database: vectors
│   └── firewall: allow-azure-services (0.0.0.0) — Container Apps egress
│       from rotating Azure IPs; not open to the public internet
│
├── Storage Account: chatbot{slug}  (hyphens stripped, max 24 chars)
│   └── Blob container: documents  (private)
│
├── Log Analytics Workspace: chatbot-{slug}-logs  (30-day retention)
│
├── Container Apps Environment: chatbot-{slug}-env
│   └── linked to Log Analytics
│
└── Container App: chatbot-{slug}   (no path-based ingress routing, so both
    │                                containers run in one app and share localhost)
    ├── Revision mode: Single
    ├── Ingress: external, target port 80  → frontend container
    ├── Scaling: min 1 replica, max 3
    ├── App secrets: acr-password, llm-api-key, storage-key,
    │                + pinecone-api-key OR vector-db-url (per vector_store)
    ├── Container: chatbot   (backend, 0.5 vCPU / 1 Gi, :8000)
    │   ├── env:    PORT, LLM_PROVIDER, AZURE_STORAGE_ACCOUNT,
    │   │           AZURE_STORAGE_CONTAINER, VECTOR_STORE, OPENAI_BASE_URL,
    │   │           OPENAI_API_BASE, LLM_MODEL
    │   │           [pinecone] PINECONE_INDEX (=chatbot-{slug}), PINECONE_ENVIRONMENT
    │   │           [pgvector] PGVECTOR_TABLE (=embeddings), PGVECTOR_DIMENSION (=384)
    │   └── secret: LLM_API_KEY, OPENAI_API_KEY, ANTHROPIC_API_KEY ← llm-api-key,
    │               AZURE_STORAGE_KEY ← storage-key,
    │               [pinecone] PINECONE_API_KEY ← pinecone-api-key
    │               [pgvector] DATABASE_URL, PGVECTOR_URL ← vector-db-url
    └── Container: frontend  (chat UI, nginx :80, 0.25 vCPU / 0.5 Gi)
        ├── env: BACKEND_PORT (nginx proxies /api → localhost:8000)
        └── image: chatbot{slug}acr.azurecr.io/chatbot-frontend:{version}

CUSTOMER'S OWN PINECONE PROJECT                  [vector_store = pinecone]
─────────────────────────────────────────────────────────────
└── Serverless index: chatbot-{slug}   (dim 384, cosine, us-east-1)
    └── same index resource as the AWS path. Azure has no pre-created secret
        store at dispatch time, so the customer's key travels as a masked
        workflow input rather than being read from their cloud.

Terraform state: s3://{TF_STATE_BUCKET}/azure/tenants/{slug}/terraform.tfstate
```

---

## Secret & Credential Flow

### AWS — LLM API Key

```
Form input (plaintext)
       │
       ▼
  AES-256-GCM encrypt ──────────────────────────► tenants.llmApiKeyEncrypted (DB)
       │
       ▼
  STS AssumeRole (customer's deploymentRoleArn)
       │
       ▼
  Secrets Manager PutSecretValue
  → customer account: {slug}/llm-api-key
  → ARN stored in tenants.llmSecretArn (DB)
       │
       ▼ (at deploy time)
  ECS execution role reads ARN
  → LLM_API_KEY injected into container as secret env var
  → plaintext only inside the running container
```

### Azure — LLM API Key

```
Form input (plaintext)
       │
       ├── AES-256-GCM encrypt ──────────────────► tenants.llmApiKeyEncrypted (DB)
       │
       ▼ (at deploy time)
  Decrypt from DB
       │
       ▼
  Passed as Terraform variable (masked in GitHub Actions logs)
       │
       ▼
  Key Vault secret: llm-api-key (written by Terraform apply)
       │
       ▼
  Container App mounts secret reference at runtime
```

### Azure — Client Secret

```
Form input (plaintext)
       │
       ▼
  AES-256-GCM encrypt ──────────────────────────► tenants.azureClientSecretEncrypted (DB)
       │
       ▼ (at deploy time)
  Decrypt from DB
       │
       ▼
  Passed as Terraform variable (masked in GitHub Actions logs)
  Used by Terraform provider to authenticate to Azure
```

### Encryption format (`src/lib/crypto.ts`)

```
PLATFORM_ENCRYPTION_KEY (32-byte hex)
       │
       ▼
  AES-256-GCM
  → random 12-byte IV each call
  → stored as: {iv_hex}:{authTag_hex}:{ciphertext_hex}
```

---

## Data Model

```
users ◄────────────────────────── accounts (GitHub OAuth)
  │                                    sessions
  │ ownerUserId
  ▼
tenants ──────────────────────────────────────────────────────────┐
  │                                                               │
  │  cloudProvider = "aws"          cloudProvider = "azure"      │
  │  ─────────────────────          ──────────────────────       │
  │  awsAccountId                   azureSubscriptionId          │
  │  awsRegion                      azureTenantId                │
  │  deploymentRoleArn              azureClientId                │
  │  s3DocsBucket                   azureClientSecretEncrypted   │
  │  s3DocsPrefix                   azureResourceGroup           │
  │  llmSecretArn                   azureRegion                  │
  │                                 azureStorageAccount          │
  │                                 azureStorageContainer        │
  │                                 azureKeyVaultName            │
  │                                                              │
  │  shared: llmProvider (openai|anthropic|openrouter),           │
  │          llmApiKeyEncrypted, llmModel, llmBaseUrl,           │
  │          vectorStore (pinecone|pgvector),                    │
  │          pineconeApiKeyEncrypted, pineconeSecretArn (AWS),   │
  │          chatbotVersion, domain, albDnsName, chatbotUrl,     │
  │          config (jsonb)                                      │
  │                                                              │
  │ tenantId                                                     │
  ▼                                                              │
deployments                                                      │
  status: pending → running → succeeded | failed | cancelled     │
  githubRunId, githubRunUrl                                      │
  errorMessage                                                   │
  triggeredByUserId ─────────────────────────────────────────────┘
                                                    (FK → users)
```

---

## Request / Response: Deployment Webhook

```
GitHub Actions                          Platform
      │                                     │
      │── POST /api/deployments/{id}/status ►│
      │   Headers:                          │
      │     x-webhook-secret: {secret}      │ timingSafeEqual check
      │   Body (running, at job start):     │
      │     {                               │
      │       "status": "running",          │ UPDATE deployments SET
      │       "githubRunId": "12345",       │   status, githubRunId,
      │       "githubRunUrl": "https://..." │   githubRunUrl
      │     }                               │
      │   Body (success):                   │
      │     {                               │
      │       "status": "succeeded",        │
      │       "albDnsName": "...",          │ UPDATE tenants SET
      │       "chatbotUrl": "...",          │   albDnsName, chatbotUrl
      │       "githubRunId": "12345",       │
      │       "githubRunUrl": "https://..." │ UPDATE deployments SET
      │     }                               │   status, githubRunId,
      │                                     │   githubRunUrl, finishedAt
      │   Body (failure):                   │
      │     {                               │
      │       "status": "failed",           │ UPDATE deployments SET
      │       "errorMessage": "...",        │   status, errorMessage,
      │       "githubRunId": "12345",       │   githubRunId, finishedAt
      │       "githubRunUrl": "https://..." │
      │     }                               │
      │◄─ 200 OK ───────────────────────────│
```

---

## Technology Stack

| Layer | Technology |
|---|---|
| Framework | Next.js 16 (App Router, Turbopack) |
| UI | React 19, Tailwind CSS 4 |
| Auth | NextAuth v5 beta, GitHub OAuth |
| Database | Neon Postgres (serverless) |
| ORM | Drizzle ORM |
| Validation | Zod v4 |
| Encryption | Node.js `crypto` — AES-256-GCM |
| AWS integration | AWS SDK v3 (STS, Secrets Manager) |
| Azure integration | `@azure/identity`, `@azure/keyvault-secrets` |
| GitHub integration | Octokit REST |
| Infrastructure | Terraform 1.9.5 — AWS provider ~5.60, azurerm ~3.110, pinecone ~2.0 |
| CI/CD | GitHub Actions |
| Runtime | Node.js on Vercel / any Node host |
