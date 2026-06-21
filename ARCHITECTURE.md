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
│  Chatbot runtime, S3/blob documents, Pinecone index, LLM calls,     │
│  CloudWatch/Log Analytics, user queries and answers                 │
│                                                                     │
│  ← platform never reads or receives any of this →                  │
└─────────────────────────────────────────────────────────────────────┘
```

The only information that crosses from data plane to control plane is deployment lifecycle data: success/failure status and the resulting chatbot URL. Do not add any endpoint, IAM role, or delegated access that would give the platform visibility into runtime traffic, documents, or logs.

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
              ┌───────────────────────────────┐
              │       GitHub Actions           │
              │  (deploy-tenant.yml or         │
              │   deploy-tenant-azure.yml)     │
              │                               │
              │  1. Pull image from ECR        │
              │  2. Push to customer registry  │
              │  3. terraform apply            │
              │  4. POST /api/deployments/*/   │
              │          status (callback)     │
              └───────────┬───────────────────┘
                          │
          ┌───────────────┴───────────────┐
          │                               │
          ▼                               ▼
┌──────────────────┐           ┌──────────────────┐
│  CUSTOMER AWS    │           │  CUSTOMER AZURE  │
│  ACCOUNT         │           │  SUBSCRIPTION    │
│                  │           │                  │
│  VPC + subnets   │           │  Resource Group  │
│  ALB             │           │  Container App   │
│  ECS Fargate     │           │  ACR             │
│  ECR             │           │  Key Vault       │
│  S3 docs bucket  │           │  Storage Account │
│  Secrets Manager │           │  Log Analytics   │
│  CloudWatch      │           │                  │
└──────────────────┘           └──────────────────┘
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
│   └── ingress alb-sg → container_port (8000)
│       egress  all
│
├── Application Load Balancer
│   └── Listener :80 → Target Group (IP mode, port 8000)
│         └── Health check GET /  matcher 200-399
│
├── ECS Cluster
│   └── Service (desired 1, Fargate, public IP)
│       └── Task Definition
│           ├── Execution Role
│           │   ├── AmazonECSTaskExecutionRolePolicy
│           │   └── secretsmanager:GetSecretValue → LLM secret ARN
│           ├── Task Role
│           │   ├── s3:ListBucket → docs bucket
│           │   └── s3:GetObject  → docs bucket/{prefix}*
│           └── Container: chatbot
│               ├── image: {customer-ecr}/{slug}/chatbot:{version}
│               ├── env:   S3_DOCS_BUCKET, S3_DOCS_PREFIX,
│               │          LLM_PROVIDER, AWS_REGION, PORT
│               └── secret: LLM_API_KEY ← Secrets Manager
│
├── S3 Bucket: chatbot-{slug}-docs
│   ├── AES-256 SSE
│   └── all public access blocked
│
├── Secrets Manager: {slug}/llm-api-key
│   └── written by platform during onboarding (AssumeRole)
│
└── CloudWatch Log Group: /ecs/chatbot-{slug}  (14-day retention)

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
│   └── image: chatbot{slug}acr.azurecr.io/chatbot:{version}
│
├── Key Vault: cb-{slug}-kv  (Standard SKU)
│   └── secret: llm-api-key  ← written by Terraform during apply
│
├── Storage Account: chatbot{slug}  (hyphens stripped, max 24 chars)
│   └── Blob container: documents  (private)
│
├── Log Analytics Workspace: chatbot-{slug}-logs  (14-day retention)
│
├── Container Apps Environment: chatbot-{slug}-env
│   └── linked to Log Analytics
│
└── Container App: chatbot-{slug}
    ├── Revision mode: Single
    ├── Ingress: external, target port 8000
    ├── Scaling: min 1 replica, max 3
    ├── env:    PORT, LLM_PROVIDER,
    │           AZURE_STORAGE_ACCOUNT, AZURE_STORAGE_CONTAINER
    └── secret: LLM_API_KEY ← Key Vault reference

Terraform state: s3://{TF_STATE_BUCKET}/tenants/azure/{slug}.tfstate
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
  │  s3DocsPrefix                   azureClientSecretEncrypted   │
  │  llmSecretArn                   azureRegion                  │
  │                                                              │
  │  shared: llmProvider, llmApiKeyEncrypted,                    │
  │          chatbotVersion, domain, albDnsName, chatbotUrl      │
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
| Infrastructure | Terraform 1.9.5, AWS provider ~5.60 |
| CI/CD | GitHub Actions |
| Runtime | Node.js on Vercel / any Node host |
