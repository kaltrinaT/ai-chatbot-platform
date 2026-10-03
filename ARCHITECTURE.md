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

**Document management is the one deliberate, narrow exception to "no IAM role" above, and it's built specifically to avoid becoming a visibility exception too.** It works the same way on both clouds. The platform lets an operator upload/delete a tenant's knowledge-base documents from its own UI, but it holds **no cloud credential of any kind** for the tenant's document storage — not even a scoped one. Instead, each tenant gets its own `docs-signer` function in its own account:

| | AWS | Azure |
|---|---|---|
| Runtime | Lambda behind a Function URL (`authorization_type = NONE`) | Linux Function App, `authLevel: "anonymous"` |
| Identity to storage | Execution role: `s3:PutObject`/`s3:DeleteObject` only — never `GetObject`, never `ListBucket` | System-assigned managed identity holding a custom role definition scoped to the docs storage account: `generateUserDelegationKey` plus `blobs/write` and `blobs/delete` — never read, never list |
| Where its shared secret lives | The tenant's Secrets Manager, read at runtime (`secretsmanager:GetSecretValue` on that one ARN) | An application setting, set by Terraform. The identity has **no Key Vault access at all** |
| Upload protocol | S3 presigned POST — a URL plus form fields the browser submits as multipart | Blob user-delegation SAS — a single URL the browser sends one `PUT` to |

The platform reaches either one only over plain authenticated HTTPS (a shared secret, no SigV4 and no Entra token), the same shape as the existing deployment-status webhook. File bytes go from the operator's browser straight to the tenant's storage and never pass through the platform's server. The platform's own Postgres (`tenant_documents`), not a listing call, is what the document list in the UI is drawn from — so the platform knows filenames and sizes (it needs to, to render a list), but at no point holds a credential capable of reading a document's content. One qualification: each Azure tenant's Terraform state records the docs storage account's access key. That account refuses Shared Key authorization, so the recorded key authorizes nothing, and the state is kept in the customer's own subscription, not with the platform (Known Limitation #9 in `SECURITY.md`). Deleting a document does purge its vectors. The reindex that follows every delete is a full resync, and it removes vectors for any document no longer in storage. That is also why the backend takes the storage prefix only from its own environment, never from the request: a caller-chosen empty prefix would make the resync purge everything (see "The chatbot's public `/api/index`" in `SECURITY.md`).

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
$14/month on AWS and $17/month on Azure for the smallest instance, plus a database to operate.

Neither option gives the platform access to embeddings. The residual risk is
the one already documented for every stored application secret: the platform
operator holds `PLATFORM_ENCRYPTION_KEY` and the database, so an encrypted
Pinecone key *could* be recovered — see Known Limitation #2 in `SECURITY.md`.
No cloud credential is recoverable that way, since none is stored.

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
│                    ├── AWS SDK (STS + Secrets Manager), onboarding  │
│                    │   only — no Azure SDK: the platform makes no   │
│                    │   Azure calls at all                           │
│                    ├── jose — verifies GitHub OIDC tokens on the    │
│                    │   Azure secret-release endpoint                │
│                    └── Octokit ──────────────────► GitHub Actions   │
│                                                         │           │
└─────────────────────────────────────────────────────────┼───────────┘
                                                          │
                              ┌───────────────────────────┘
                              │  workflow_dispatch
                              ▼
              ┌──────────────────────────────────────────┐
              │              GitHub Actions              │
              │  job environment: tenant-{id}, so each   │
              │  run's OIDC token names its tenant       │
              │                                          │
              │  deploy-tenant.yml (AWS):                │
              │    1. Pull image from platform ECR       │
              │    2. Sign in to the tenant role (OIDC)  │
              │    3. Replicate to customer ECR          │
              │    4. terraform apply                    │
              │                                          │
              │  deploy-tenant-azure.yml (Azure):        │
              │    1. Fetch secrets from the platform    │
              │    2. Pull image from platform ECR       │
              │    3. Sign in to the customer (OIDC)     │
              │    4. Replicate to customer ACR          │
              │    5. terraform apply (twice)            │
              │                                          │
              │  Also: destroy-tenant(-azure).yml,       │
              │        verify-tenant-{aws,azure}.yml     │
              │                                          │
              │  All: POST /api/deployments/{id}/        │
              │       status  (running, then final)      │
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
│  docs-signer fn  │           │  docs-signer fn  │  │  index per tenant:  │
│  Secrets Manager │           │  Log Analytics   │  │  chatbot-{slug}     │
│  CloudWatch      │           │                  │  │                     │
│                  │           │                  │  │  billed to the      │
│  vector_store =  │           │  vector_store =  │  │  customer's own     │
│  "pgvector"? →   │           │  "pgvector"? →   │  │  Pinecone account   │
│  RDS + pgvector  │           │  Azure PG +      │  │                     │
│                  │           │  pgvector        │  │                     │
└──────────────────┘           └──────────────────┘  └─────────────────────┘
```

---

## Tenant Onboarding & Deployment Flow

Before the form is submitted, the wizard generates the tenant's ID and checks
the slug as it is typed: against every tenant, live or deleted; on Azure,
against the names every live Azure tenant derives from its slug; and against
DNS (Azure) or S3 (AWS) for the globally unique names someone outside the
platform may hold. Only once the slug is confirmed free does it show the
customer's one-click setup — a CloudFormation stack or a subscription-level ARM
deployment, both prefilled — which creates the deployment identity trusting
`repo:{owner}/{repo}:environment:tenant-{id}`, and the Terraform state storage,
in the customer's own cloud. The customer pastes the identity back, and the
wizard refuses one another tenant already uses.

```
Operator                Platform (Next.js)           Customer Cloud      GitHub Actions
   │                          │                            │                    │
   │── submit wizard ────────►│                            │                    │
   │   (server action)        │                            │                    │
   │                          │ validate (Zod), then the   │                    │
   │                          │ slug and identity checks   │                    │
   │                          │ again — before any cloud   │                    │
   │                          │ call                       │                    │
   │                          │                            │                    │
   │                   ┌──────┴───────┐                    │                    │
   │              AWS  │              │ Azure               │                    │
   │                   │              │                     │                    │
   │              STS AssumeRole      │ encrypt LLM +       │                    │
   │              write LLM +         │ Pinecone keys,      │                    │
   │              Pinecone secrets    │ store in DB; no     │                    │
   │              to Secrets Manager  │ Azure credential    │                    │
   │              generate + write    │ generate docs-      │                    │
   │              docs-signer secret  │ signer secret; no   │                    │
   │              store ARNs in DB    │ Azure call possible │                    │
   │                                  │ (no vault yet)      │                    │
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
   │◄─ live progress in the ──│                            │  pull ECR image    │
   │   wizard's last step     │                            │                    │
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
   │                          │   (chatbotUrl, albDnsName, │                    │
   │                          │    docsSignerUrl, and the  │                    │
   │                          │    Azure resource names)   │                    │
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
│   ├── ingress 0.0.0.0/0 → port 80
│   └── ingress 0.0.0.0/0 → port 443   [only with acm_certificate_arn]
│
├── Security Group: task
│   └── ingress alb-sg → frontend_port (80)  + container_port (8000)
│       egress  all
│
├── CloudFront distribution: [no acm_certificate_arn — i.e. the default]
│   ├── viewer: redirect-to-https on *.cloudfront.net, AWS-managed cert
│   ├── origin: this ALB over HTTP; caching disabled, all methods allowed,
│   │           every header but Host forwarded, 60s origin read timeout
│   └── Exists because ACM cannot issue for the ALB's own hostname, so a
│       tenant that brings no domain has no other route to TLS. The
│       CloudFront→ALB hop stays unencrypted, and the ALB stays publicly
│       reachable on :80 — a tenant wanting TLS end to end, and only one
│       reachable address, supplies a certificate instead.
│
├── Application Load Balancer
│   │
│   │  Without a certificate, :80 serves traffic and there is no :443. With
│   │  one, :80 only redirects and every route below moves to :443. See the
│   │  acm_certificate_arn and enable_cdn variables.
│   │
│   ├── Listener :80
│   │     ├── [no cert]  default action    → Frontend Target Group (port 80)
│   │     │                rule /api/* (10) → Backend Target Group (port 8000)
│   │     └── [cert]     default action    → 301 redirect to https://:443
│   │
│   └── Listener :443                       [only with acm_certificate_arn]
│         ├── certificate: customer-issued ACM cert covering `domain`
│         ├── ssl_policy: ELBSecurityPolicy-TLS13-1-2-2021-06
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
│   │           ├── env:   TENANT_ID, S3_DOCS_BUCKET, S3_DOCS_PREFIX,
│   │           │          LLM_PROVIDER, AWS_REGION, PORT, VECTOR_STORE,
│   │           │          OPENAI_BASE_URL, OPENAI_API_BASE, LLM_MODEL
│   │           │          [pinecone] PINECONE_INDEX (=chatbot-{slug})
│   │           │          [pgvector] PGVECTOR_TABLE (=embeddings),
│   │           │                     PGVECTOR_DIMENSION (=384)
│   │           │          note: unlike Azure, PINECONE_ENVIRONMENT is not set
│   │           └── secret: LLM_API_KEY, OPENAI_API_KEY,
│   │                       ANTHROPIC_API_KEY ← LLM secret,
│   │                       [pinecone] PINECONE_API_KEY ← Pinecone secret
│   │                       [pgvector] DATABASE_URL, PGVECTOR_URL
│   │                                  ← {slug}/vector-db-url
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
│   └── CORS: POST from PLATFORM_BASE_URL, plus EXTRA_CORS_ORIGIN if set
│       (browser → S3 uploads; any other origin fails the preflight)
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
│   ├── db.t4g.micro, 20 GB gp3, storage encrypted, 1-day backups
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

CloudFormation stack: chatbot-bootstrap-{slug}   (created by the CUSTOMER,
│                                                 before onboarding)
├── IAM OIDC provider: token.actions.githubusercontent.com
│   └── skipped when the account already has one (CreateGitHubOidcProvider=No)
├── IAM Role: chatbot-client-deploy-{slug}   (1-hour maximum session)
│   ├── trust GitHubActionsDeploy: sts:AssumeRoleWithWebIdentity,
│   │     sub = repo:{owner}/{repo}:environment:tenant-{id}, aud = sts.amazonaws.com
│   │     — every deploy, teardown and connection check
│   ├── trust PlatformOnboarding: sts:AssumeRole from the platform account,
│   │     sts:ExternalId = {tenant id} — onboarding's secret writes only
│   └── permissions: what Terraform needs to build everything above
└── S3 Bucket: tfstate-{slug}-{account}-{region}-an
    ├── this chatbot's Terraform state (terraform.tfstate), in the customer's
    │   own account rather than the platform's
    ├── account-regional namespace: no other AWS account can create this name
    ├── versioned (superseded versions expire after 30 days), private, TLS-only
    ├── S3 lock file per run (use_lockfile, Terraform 1.15.3)
    └── retained when the stack is deleted — the customer deletes it last
```

---

## Azure Infrastructure (per tenant)

```
CUSTOMER AZURE SUBSCRIPTION
─────────────────────────────────────────────────────────────
Resource Group: chatbot-{slug}   (created by the CUSTOMER's setup deployment,
│                                 before onboarding; Terraform only reads it)
│
├── Managed Identity: chatbot-deploy-{slug}   (user-assigned, created by the setup)
│   ├── federated credential: issuer token.actions.githubusercontent.com,
│   │     audience api://AzureADTokenExchange,
│   │     subject repo:{owner}/{repo}:environment:tenant-{id}
│   └── Contributor + User Access Administrator on THIS resource group only
│
├── Container Registry: chatbot{slug}  (hyphens stripped; Basic SKU, admin
│   │                                  user disabled)
│   │  images are the platform's prebuilt golden images, pulled from the
│   │  platform ECR and replicated here by deploy-tenant-azure.yml — same
│   │  model AWS uses to replicate into the customer's ECR
│   ├── image: chatbot{slug}.azurecr.io/chatbot-backend:{version}
│   └── image: chatbot{slug}.azurecr.io/chatbot-frontend:{version}
│
├── Key Vault: cb-{slug}-kv  (Standard SKU)
│   ├── secret: llm-api-key        ← written by Terraform during apply
│   ├── secret: pinecone-api-key   ← customer's own key  [vector_store = pinecone]
│   ├── secret: vector-db-url      ← Postgres URL        [vector_store = pgvector]
│   │   (no storage-key — nothing uses the docs account key, and the account
│   │    refuses it: both containers reach Blob Storage through managed
│   │    identities. Terraform state still records the key; see below)
│   ├── secret: docs-signer-secret ← shared auth secret for the Function below
│   ├── Access policy: the deploying identity ONLY. The Container App
│   │   does not read from this vault — Terraform sets its app secrets directly
│   │   (see below), so the vault is a durable record, not the injection path.
│   └── On destroy: secrets purged, vault only soft-deleted — purging a vault
│       is a subscription-level action the deploying identity lacks
│
├── PostgreSQL Flexible Server: chatbot-{slug}-pg  [vector_store = pgvector]
│   ├── B_Standard_B1ms, 32 GB, PG 16, 7-day backups
│   ├── azure.extensions = VECTOR  (allows CREATE EXTENSION vector)
│   ├── database: vectors
│   └── firewall: allow-azure-services (0.0.0.0) — Container Apps egress
│       from rotating Azure IPs; not open to the public internet
│
├── Storage Account: chatbot{slug}  (hyphens stripped, max 24 chars)
│   ├── Blob container: documents  (private)
│   ├── Shared Key authorization: DISABLED. Only Entra ID identities and
│   │     user-delegation SAS tokens work, so the access key Terraform
│   │     records in state authorizes nothing. Terraform itself manages the
│   │     container through Entra ID (provider storage_use_azuread).
│   └── CORS: PUT from PLATFORM_BASE_URL, plus EXTRA_CORS_ORIGIN if set
│       (browser → Blob uploads; the origin must match exactly)
│
├── Storage Account: chatbot{slug}fn  (truncated to 22 chars, then "fn")
│   └── the Azure Functions runtime's own bookkeeping store. Deliberately
│       separate from the docs account so the docs-signer identity's role
│       never has to cover anything but the tenant's documents. Keeps Shared
│       Key on: a Linux Consumption host needs it (Known Limitation #9).
│
├── Service Plan: chatbot-{slug}-docs-signer-plan  (Y1 Consumption)
│
├── Function App: chatbot-{slug}-docs-signer  (Linux, Node 20, https_only)
│   ├── Publishing: FTP and WebDeploy basic auth DISABLED — code is deployed
│   │     only with the workflow's federated identity
│   ├── Route: POST /api/docs-signer   authLevel: "anonymous"
│   │     auth is the shared-secret header, mirroring the Lambda Function
│   │     URL's authorization_type = NONE on the AWS side
│   ├── Identity: system-assigned
│   ├── Custom role definition, scoped to the docs storage account ONLY:
│   │     actions:      generateUserDelegationKey
│   │     data actions: blobs/write, blobs/delete
│   │     (never read, never list — blobs/write is required because a
│   │      user-delegation SAS is capped by its signer's own permissions)
│   ├── DOCS_SIGNER_SECRET arrives as an app setting, so this identity holds
│   │   NO Key Vault access — access policies cannot be scoped to one secret
│   └── Mints a user-delegation SAS for the browser to PUT to, and performs
│       deletes itself. Same contract as the AWS Lambda, different protocol.
│
├── Log Analytics Workspace: chatbot-{slug}-logs  (30-day retention)
│
├── Container Apps Environment: chatbot-{slug}-cae
│   ├── environmentMode WorkloadProfiles, Consumption profile only — stated
│   │   through azapi, because an environment left to Azure's default
│   │   came up Express, which refuses sidecars, probes and revision suffixes
│   └── linked to Log Analytics
│
└── Container App: chatbot-{slug}   (no path-based ingress routing, so both
    │                                containers run in one app and share localhost)
    ├── Revision mode: Single; workload profile: Consumption
    ├── Ingress: external, target port 80  → frontend container
    ├── Scaling: min 1 replica, max 3
    ├── Identity: user-assigned (chatbot-{slug}-chatbot-id), created in the
    │             bootstrap apply before the app exists, holding:
    │               AcrPull on the registry — image pulls, no admin user
    │               containers/read + blobs/read on the docs storage account
    │             Separate from the docs-signer's write+delete identity —
    │             neither can perform the other's operation, and neither
    │             holds the storage account key or a registry password.
    ├── Registry: identity-based pull; the ACR admin user is disabled
    ├── App secrets: llm-api-key,
    │                + pinecone-api-key OR vector-db-url (per vector_store)
    ├── Container: chatbot   (backend, 0.5 vCPU / 1 Gi, :8000)
    │   ├── env:    PORT, LLM_PROVIDER, AZURE_STORAGE_ACCOUNT,
    │   │           AZURE_STORAGE_CONTAINER, VECTOR_STORE, OPENAI_BASE_URL,
    │   │           OPENAI_API_BASE, LLM_MODEL
    │   │           [pinecone] PINECONE_INDEX (=chatbot-{slug}), PINECONE_ENVIRONMENT
    │   │           [pgvector] PGVECTOR_TABLE (=embeddings), PGVECTOR_DIMENSION (=384)
    │   └── secret: LLM_API_KEY, OPENAI_API_KEY, ANTHROPIC_API_KEY ← llm-api-key,
    │               [pinecone] PINECONE_API_KEY ← pinecone-api-key
    │               [pgvector] DATABASE_URL, PGVECTOR_URL ← vector-db-url
    └── Container: frontend  (chat UI, nginx :80, 0.25 vCPU / 0.5 Gi)
        ├── env: BACKEND_PORT (nginx proxies /api → localhost:8000)
        └── image: chatbot{slug}.azurecr.io/chatbot-frontend:{version}

CUSTOMER'S OWN PINECONE PROJECT                  [vector_store = pinecone]
─────────────────────────────────────────────────────────────
└── Serverless index: chatbot-{slug}   (dim 384, cosine, us-east-1)
    └── same index resource as the AWS path. Azure has no pre-created secret
        store at dispatch time, so the run fetches the customer's key from
        the platform with its OIDC token (see "Azure — LLM API Key" below)
        rather than reading it from their cloud.

Storage Account: cbtf{slug}   (hyphens stripped; created by the setup, inside
│                              the resource group above)
├── container tfstate: this chatbot's Terraform state (terraform.tfstate),
│   in the customer's own subscription rather than the platform's
├── Shared Key disabled: Entra ID only. The deployment identity holds
│   Storage Blob Data Contributor on this container and nothing else
├── Terraform's backend signs in with the run's GitHub OIDC token
│   (use_oidc, use_azuread_auth) and takes a blob lease per run
└── versioned; superseded versions expire after 30 days
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
  STS AssumeRole (customer's deploymentRoleArn, ExternalId = tenant id —
  their trust policy conditions on it, so the role serves one tenant only)
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
       ▼ (at deploy time — never a dispatch input)
  Run requests a GitHub OIDC token, audience ai-chatbot-platform:tenant-secrets
       │
       ▼
  POST /api/deployments/{id}/secrets   Authorization: Bearer <token>
    platform checks: GitHub signature · repository · sub = …:environment:tenant-{id}
                     · workflow_ref = deploy-tenant-azure.yml@deploy ref
                     · deployment active, unclaimed, same run  (one UPDATE)
       │ all hold → decrypt and release, once per deployment
       ▼
  Masked, written to a runner-temp file, sourced by the Terraform steps only
       │
       ▼
  Passed as Terraform variable
       │
       ├──► Key Vault secret: llm-api-key (written by Terraform apply)
       │      a durable copy the customer can see and rotate
       │
       └──► Container App secret: llm-api-key (value set by Terraform)
              → LLM_API_KEY in the container; this is what the app reads
```

### Azure — Subscription Access (no credential)

```
Onboarding                                   Customer's setup deployment (once, in
  wizard generates tenant id (UUID)            their own subscription), from the
  and shows it as "Chatbot Id" ─────────────►  wizard's link or az command:
                                                 resource group chatbot-{slug}
                                                 managed identity + federated credential:
                                                   issuer   token.actions.githubusercontent.com
                                                   audience api://AzureADTokenExchange
                                                   subject  repo:{owner}/{repo}:environment:tenant-{id}
                                                 roles on that resource group only
                                                 state storage cbtf{slug}

Deploy (deploy-tenant-azure.yml, job environment: tenant-{id})
  GitHub signs OIDC token, sub = …:environment:tenant-{id}
       │
       ▼
  azure/login + azurerm + azapi (use_oidc) ──► Entra ID: subject matches this identity's credential?
                                          │ yes → short-lived access token (never stored)
                                          │ no  → login refused, nothing created
       ▼
  terraform apply in the customer's subscription

Stored by the platform: subscription id, Entra tenant id, client id. No secret.
```

The subject names the tenant, not the branch, so one customer's credential
never accepts another tenant's run. See "Azure Security Model" in `SECURITY.md`.

### Both clouds — docs-signer shared secret

The one credential the platform deliberately keeps **usable**, rather than
write-once-and-forget: it needs the plaintext again on every document upload and
delete. Re-fetching it from the tenant's cloud each time would mean touching
tenant cloud credentials on an ongoing basis, which is exactly what this design
avoids.

```
randomBytes(32).toString("hex")
       │
       ├── AES-256-GCM encrypt ──────► tenants.docsSignerSecretEncrypted (DB)
       │                                the platform's own durable copy
       │
       ├── AWS   STS AssumeRole → Secrets Manager PutSecretValue
       │         → {slug}/docs-signer-secret
       │         → ARN in tenants.docsSignerSecretArn; only the ARN travels
       │           through GitHub Actions afterwards, like llm-api-key
       │         → the Lambda reads the value at runtime and caches it warm
       │
       └── Azure No vault exists at onboarding — Terraform creates it during
                 the deploy — so nothing is written and docsSignerSecretArn
                 stays null. On every deploy the run fetches the plaintext
                 from the platform with its OIDC token, exactly as the LLM
                 key above; it is written to Key Vault and set directly as
                 the Function App's DOCS_SIGNER_SECRET.

At call time (both clouds):
  POST tenants.docsSignerUrl
    header x-docs-signer-secret: {plaintext}
    → compared with timingSafeEqual inside the function
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
tenants
  │
  │   cloudProvider = "aws"          cloudProvider = "azure"
  │   ─────────────────────          ──────────────────────
  │   awsAccountId                   azureSubscriptionId
  │   awsRegion                      azureTenantId
  │   deploymentRoleArn              azureClientId  (no secret column)
  │   s3DocsBucket  (see note)       azureResourceGroup
  │   s3DocsPrefix                   azureRegion
  │   acmCertificateArn              azureStorageAccount
  │   llmSecretArn                   azureStorageContainer
  │   pineconeSecretArn              azureKeyVaultName
  │   docsSignerSecretArn
  │
  │   shared: llmProvider (openai|anthropic|openrouter),
  │           llmApiKeyEncrypted, llmModel, llmBaseUrl,
  │           vectorStore (pinecone|pgvector), pineconeApiKeyEncrypted,
  │           docsSignerSecretEncrypted, docsSignerUrl,
  │           chatbotVersion, domain, albDnsName, chatbotUrl,
  │           config (jsonb), deletedAt (soft delete)
  │
  ├── deployments                                    tenantId
  │     kind: deploy | destroy
  │     status: pending → running → succeeded | failed | cancelled
  │       (forward only; at most one pending/running per tenant — unique index)
  │     chatbotVersion, githubRunId, githubRunUrl
  │     secretsClaimedAt — Azure: when the run fetched its secrets (set once)
  │     errorMessage, startedAt, finishedAt
  │     triggeredByUserId ─────────────────────────────► users
  │
  └── tenant_documents                               tenantId
        objectKey — minted by the docs-signer, never client-supplied
        displayName, contentType, sizeBytes
        status: pending | uploaded | failed
        uploadedByUserId ───────────────────────────► users

tenant_drafts — owned by users, NOT attached to a tenant
  name, step, data (jsonb)
  Non-secret wizard state only: llmApiKey and pineconeApiKey are stripped
  before saving and must be re-entered on resume. The generated tenantId is
  kept, since the customer's setup may already trust it. Deliberately not a
  tenants row with nullable columns, so a draft can never be deployed.
  Deleted once the tenant it describes exists.

Note: s3DocsBucket exists in the schema but nothing ever writes it, so it is
null for every tenant. The name is deterministic — chatbot-{slug}-docs — and
is derived rather than read (see docsBucketName in src/lib/reindex.ts).
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
      │     {                               │ UPDATE deployments SET
      │       "status": "succeeded",        │   status, githubRunId,
      │       "albDnsName": "...",          │   githubRunUrl, finishedAt
      │       "chatbotUrl": "...",          │
      │       "docsSignerUrl": "...",       │ UPDATE tenants SET
      │       "githubRunId": "12345",       │   albDnsName, chatbotUrl,
      │       "githubRunUrl": "https://..." │   docsSignerUrl
      │     }                               │
      │   Azure also sends, and the platform│ every optional field is
      │   also stores: azureResourceGroup,  │ written only when present
      │   azureStorageAccount,              │
      │   azureStorageContainer,            │ if the deployment's kind is
      │   azureKeyVaultName                 │ "destroy", a succeeded status
      │                                     │ instead sets tenants.deletedAt
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
| AWS integration | AWS SDK v3 (STS, Secrets Manager), for onboarding only |
| Azure integration | None in the application. Customer setup is an ARM template; deploys use GitHub OIDC and Terraform |
| Token verification | `jose`, for GitHub OIDC tokens on the Azure secret-release endpoint |
| GitHub integration | Octokit REST |
| Customer setup | CloudFormation (AWS) and a subscription-level ARM template (Azure), published to a public bucket |
| Infrastructure | Terraform 1.15.3 — AWS provider ~5.60; azurerm ~3.110 and azapi ~2.0; pinecone ~2.0; random ~3.6 |
| CI/CD | GitHub Actions, with one environment per tenant |
| Tests | Vitest |
| Runtime | Node.js; run locally by the operator, with a copy on Vercel serving the workflows' callbacks (`LIMITATIONS.md` #7) |
