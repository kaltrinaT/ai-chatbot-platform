# Deploying a Tenant Chatbot: AWS vs Azure

This document walks through what happens, step by step, when the platform deploys a tenant's chatbot to **AWS** and to **Azure**, and then compares the two paths.

It describes the system as the code implements it. The sources are:

| Concern | AWS | Azure |
|---|---|---|
| Onboarding (before dispatch) | [`src/app/tenants/new/actions.ts`](../src/app/tenants/new/actions.ts), [`src/lib/aws.ts`](../src/lib/aws.ts) | [`src/app/tenants/new/actions.ts`](../src/app/tenants/new/actions.ts), [`src/lib/azure.ts`](../src/lib/azure.ts) |
| Dispatch | [`src/lib/deploy.ts`](../src/lib/deploy.ts) `buildAwsInputs` | [`src/lib/deploy.ts`](../src/lib/deploy.ts) `buildAzureInputs` |
| Pipeline | [`.github/workflows/deploy-tenant.yml`](../.github/workflows/deploy-tenant.yml) | [`.github/workflows/deploy-tenant-azure.yml`](../.github/workflows/deploy-tenant-azure.yml) |
| Infrastructure | [`infra/terraform/`](../infra/terraform/) | [`infra/terraform/azure/`](../infra/terraform/azure/) |
| Document signer | [`infra/lambda/docs-signer/`](../infra/lambda/docs-signer/) | [`infra/azure-functions/docs-signer/`](../infra/azure-functions/docs-signer/) |
| Teardown | [`.github/workflows/destroy-tenant.yml`](../.github/workflows/destroy-tenant.yml) | *not implemented* |
| Cost model | [`src/lib/pricing.ts`](../src/lib/pricing.ts) | [`src/lib/pricing.ts`](../src/lib/pricing.ts) |

The customer-facing preparation steps (creating the IAM role or service principal) are covered in more detail in [`CLIENT-DEPLOYMENT-GUIDE.md`](../CLIENT-DEPLOYMENT-GUIDE.md). This document focuses on the deployment itself.

Related figures: [AWS pipeline](figures/fig-11-aws-deployment-pipeline.svg), [Azure pipeline](figures/fig-12-azure-deployment-pipeline.svg), [pipeline comparison](figures/fig-17-pipeline-comparison.svg), [AWS tenant infrastructure](figures/fig-04-aws-tenant-infrastructure.svg), [Azure tenant infrastructure](figures/fig-05-azure-tenant-infrastructure.svg), [secret flow](figures/fig-06-secret-flow.svg), [estimated cost](figures/fig-13-estimated-cost-by-cell.svg).

---

## 1. What both paths have in common

Both clouds follow the same model. The differences in section 4 are all variations on this.

1. **The platform is a control plane.** It stores tenant configuration and triggers deployments. The chatbot, its documents and its vector store run in the **customer's own** AWS account or Azure subscription.
2. **One golden image, replicated per tenant.** The platform's ECR holds one backend image and one frontend (chat UI) image. Every deploy copies both into the tenant's own registry: ECR on AWS, ACR on Azure. Nothing is built from source per tenant.
3. **GitHub Actions runs the deploy.** The platform calls `workflow_dispatch` with the tenant's inputs. The workflow pushes the images and runs `terraform apply`.
4. **Terraform state lives in the platform's S3 bucket**, one state file per tenant, **for both clouds**.
5. **Status comes back by webhook.** The workflow POSTs `running`, then `succeeded` or `failed`, to `PLATFORM_BASE_URL/api/deployments/<id>/status`, authenticated with `x-webhook-secret`. The Terraform outputs are also uploaded as a `deployment-outputs-<id>` artifact that is kept for 90 days, so the platform can recover them if the final callback is lost.
6. **The same runtime components on both clouds:** a backend container (port 8000, health check `/api/health`), a frontend nginx container (port 80), a private documents store, a docs-signer function that can write and delete documents but never read them, and a vector store. The vector store is either the customer's own Pinecone index (384-dim, cosine, AWS `us-east-1`) or managed Postgres with pgvector.
7. **The same LLM wiring.** `openai`, `anthropic` or `openrouter` sets `OPENAI_BASE_URL`, and `LLM_MODEL` is used when no model is given.

### Operator prerequisites (shared)

| Kind | Name | Used by |
|---|---|---|
| Platform env | `PLATFORM_CHATBOT_IMAGE_URI`, `PLATFORM_FRONTEND_IMAGE_URI` (no tag) | `triggerDeployment` — without them, dispatch is refused |
| Platform env | `CHATBOT_DEPLOY_REF` (default `main`) | git ref the workflow runs from |
| Platform env | `AWS_PROFILE` (`platform-control-plane`) | onboarding's `sts:AssumeRole`, assumed from the operator's `aws login` session. **No AWS access key is stored for the application either**; see [`infra/platform/control-plane`](../infra/platform/control-plane/) |
| GitHub variable | `AWS_PLATFORM_DEPLOY_ROLE_ARN` | the platform role GitHub Actions assumes through OIDC: pulling from platform ECR, chaining into the tenant role (AWS), S3 state (Azure). **No AWS access key is stored in GitHub**; see [`infra/platform/github-oidc`](../infra/platform/github-oidc/) |
| GitHub secret | `TF_STATE_BUCKET`, `TF_STATE_REGION` | Terraform backend (both) |
| GitHub secret | `PLATFORM_BASE_URL`, `PLATFORM_WEBHOOK_SECRET` | status callbacks, CORS origin for document uploads |
| GitHub variable | `EXTRA_CORS_ORIGIN` (optional) | an extra upload origin, e.g. `http://localhost:3000` |

---

## 2. AWS deployment, step by step

### Phase A — Customer preparation (in their AWS account)

1. **Get the account ID and choose a region.**
2. **Create an IAM role** whose trust policy allows the platform account to call `sts:AssumeRole`, with **no** `ExternalId` condition.
3. **Name it `chatbot-client-deploy-*`.** The platform's own IAM policy can only assume roles that match this pattern.
4. **Attach the permissions policy:** `ec2`, `elasticloadbalancing`, `ecs`, `ecr`, `s3`, `lambda`, `secretsmanager`, `logs`, `rds`, `cloudfront`, plus a limited set of IAM actions for creating task and Lambda roles.
5. **Get the LLM API key, and the Pinecone key if using Pinecone.**
6. *(Optional)* **Request an ACM certificate** for a custom hostname, in the same region, validated through DNS.

### Phase B — Onboarding (platform server action `createTenantAndDeploy`)

7. **The form is validated** (`TenantInput`). The slug must be 3–21 characters, because the frontend target group is named `chatbot-<slug>-ui` and AWS caps that at 32.
8. **The platform assumes the tenant role** with STS for a 15-minute session.
9. **The platform writes the secrets into the customer's Secrets Manager:**
   - `<slug>/llm-api-key`
   - `<slug>/pinecone-api-key` (Pinecone only)
   - `<slug>/docs-signer-secret`, a random 32-byte value (`ensureDocsSignerSecret`)

   Only the **ARNs** are kept for the deploy. The platform also keeps its own encrypted copy of the docs-signer secret, because it sends that secret with every document operation.
10. **The tenant row is inserted** and `triggerDeployment` runs. It creates a `deployments` row with status `pending` and dispatches `deploy-tenant.yml` with the inputs from `buildAwsInputs`. These are all plain strings, and **no secret values are included**. The row then moves to `running`.

### Phase C — Pipeline (`deploy-tenant.yml`, 45-minute timeout)

| # | Step | What happens |
|---|---|---|
| 11 | Notify platform — run started | POSTs `running` with the run ID and URL. Any response other than HTTP 200 marks the step as failed, but the step is `continue-on-error`. |
| 12 | Checkout | |
| 13 | Configure AWS credentials (platform role via OIDC) | Exchanges GitHub's signed OIDC token for one-hour credentials on the platform role, used to read the source ECR. No stored key. |
| 14 | Pull source images | `docker pull` of the backend and frontend images |
| 15 | Configure AWS credentials (client) | **Chains from the platform role into `deployment_role_arn`** (`role-chaining: true`). AWS caps a chained session at 1 hour. |
| 16 | Replicate images to client ECR | Creates `<slug>/chatbot` and `<slug>/chatbot-frontend` if missing (scan on push), then tags and pushes `:<chatbot_version>` |
| 17 | Ensure ECS service-linked role | Idempotent `iam create-service-linked-role` |
| 18 | Terraform init | Terraform 1.9.5, S3 backend, key `tenants/<slug>.tfstate` |
| 19 | Read customer Pinecone key | Pinecone only: reads the value from **the customer's** Secrets Manager under the assumed role and masks it |
| 20 | Install docs-signer Lambda deps | `npm install --production`, because `archive_file` zips whatever is on disk |
| 21 | **Terraform apply** | Single apply; resources are listed below |
| 22 | Grant the Function URL invoke permission | Imperative `aws lambda add-permission --invoked-via-function-url`. AWS provider `~> 5.60` cannot express this (see §5). |
| 23 | Read Terraform outputs | `alb_dns_name`, `chatbot_url`, `docs_signer_url` |
| 24 | Upload deployment outputs | `outputs.json` artifact, kept 90 days |
| 25 | Notify platform — success / failure | A lost success callback is reported as an annotation but does not fail the run |

**What step 21 creates:**

- **Network:** VPC `10.20.0.0/16`, internet gateway, 2 public subnets in 2 AZs, route table. No NAT gateway: tasks get public IPs.
- **Security groups:** the ALB accepts :80 from anywhere, and :443 only when a certificate is set. Tasks accept only the ALB, on 8000 and 80.
- **ALB** with idle timeout 180s, two target groups, and a listener rule sending `/api/*` to the backend and everything else to the frontend. With a certificate, there is an HTTPS listener (TLS 1.2/1.3) and a 301 redirect from :80.
- **CloudFront** (created when there is no certificate and `enable_cdn=true`): caching disabled, `redirect-to-https`, origin is the ALB over HTTP, 60s origin read timeout.
- **ECS:** one cluster and two Fargate services with `desired_count = 1`. The backend has 1 vCPU / 2 GB and the frontend 0.25 vCPU / 0.5 GB. Both services use `force_new_deployment`, a deployment circuit breaker with rollback, and `wait_for_steady_state`.
- **IAM:**
  - The execution role can read only the listed secret ARNs.
  - The task role has `s3:ListBucket` plus `s3:GetObject` on the prefix.
  - The Lambda role has only `s3:PutObject` and `s3:DeleteObject`, plus read access to its own secret.
- **S3 `chatbot-<slug>-docs`:**
  - SSE-AES256, public access blocked, `force_destroy`
  - Versioning, with noncurrent versions expiring after 30 days and incomplete multipart uploads aborted after 7 days
  - CORS allows `POST` from the platform origin
- **Docs-signer Lambda** (Node 20, 128 MB) behind a Function URL with `authorization_type = NONE`. Authentication is the shared-secret header checked inside the handler.
- **CloudWatch log groups** with 14-day retention.
- **Vector store:** either a `pinecone_index`, or RDS Postgres 16 (`db.t4g.micro`, 32 GB gp3, encrypted, not publicly accessible, security group allows only the tasks) with its connection URL stored in Secrets Manager.
- **Secrets reach containers through ECS `secrets.valueFrom`.** The value is resolved at task start and never appears in Terraform variables or GitHub inputs.

### Phase D — Result

26. **Chatbot URL**, chosen by `outputs.tf`:
    - A certificate and domain → `https://<domain>`
    - Otherwise CloudFront → `https://<id>.cloudfront.net`
    - Otherwise → `http://<alb-dns>`
27. **Redeploy** repeats steps 10–25. `force_new_deployment` makes ECS pull the mutable tag again.
28. **Destroy** (`destroy-tenant.yml`, 60-minute timeout):
    1. Documents are deleted through the signer, best effort.
    2. The platform role is assumed through OIDC, the tenant role is chained from it, and the bucket is emptied, including all object versions. Both sessions start in the job's first minute and outlast its 60-minute timeout, which is why that timeout must not be raised without refreshing credentials.
    3. `terraform destroy` runs.
    4. The two ECR repositories and the Secrets Manager secrets written by the platform are deleted.

---

## 3. Azure deployment, step by step

### Phase A — Customer preparation (in their Azure subscription)

1. **Get the subscription ID and the Entra tenant ID.**
2. **Create an App Registration** (service principal) and record its client ID.
3. **Create a client secret** and copy its value.
4. **Assign `Contributor` and `User Access Administrator` at subscription scope.** Subscription scope is required because the resource group does not exist yet. The second role is needed because Terraform creates custom role definitions and assigns them.
5. **Choose a region** (default `eastus`).
6. **Get the LLM API key, and the Pinecone key if using Pinecone.**

### Phase B — Onboarding (platform server action `createTenantAndDeploy`)

7. **The form is validated.** The slug must be **3–18 characters**, because Key Vault names are limited to 24 characters and the vault is named `cb-<slug>-kv`.
8. **No call is made to the customer's cloud.** The customer's Key Vault does not exist yet: Terraform creates it during the deploy. Instead the platform:
   - encrypts the client secret, the LLM key and the Pinecone key (AES-256-GCM in the platform database)
   - generates the docs-signer secret locally (`generateDocsSignerSecret`) and stores it encrypted
9. **The tenant row is inserted** and `triggerDeployment` dispatches `deploy-tenant-azure.yml` with `buildAzureInputs`:
   - Non-secret settings are packed into a single JSON `config` input. This workaround dates from when `workflow_dispatch` allowed only 10 inputs.
   - **The decrypted client secret, LLM key, Pinecone key and docs-signer secret are sent as workflow inputs.**

### Phase C — Pipeline (`deploy-tenant-azure.yml`, 45-minute timeout)

| # | Step | What happens |
|---|---|---|
| 10 | Mask secret inputs | `::add-mask::` for all four secret inputs |
| 11 | Notify platform — run started | Same as AWS |
| 12 | Parse tenant config | `jq` checks the IDs are present and applies defaults: region `eastus`, version `latest`, vector store `pinecone` |
| 13 | Checkout | |
| 14 | Compute resource names | ACR name `chatbot<slug-without-hyphens>`. The source ECR region is **read from the image URI**, not taken from the tenant's region. |
| 15 | Configure AWS credentials (platform role via OIDC) | Same OIDC platform role as AWS. Its credentials serve the rest of the job: the source ECR here, and the S3 state backend in every Terraform step. |
| 16 | Pull source images | Same golden images as AWS |
| 17 | Azure login | `azure/login@v2` with the customer's service principal |
| 18 | Terraform init | Terraform `~1.6`, **S3** backend, key `azure/tenants/<slug>/terraform.tfstate`. AWS credentials come from the job environment set by step 15. No step sets its own, because step-level keys would override the OIDC credentials. |
| 19 | **Terraform apply — bootstrap** | `-target` the resource group, the ACR, the chatbot's **user-assigned identity** and its **`AcrPull`** grant, with placeholder image URIs. The registry must exist before images are pushed, and the identity must hold `AcrPull` before the app's first revision pulls. A 90-second pause follows for the grant to propagate. |
| 20 | Log in to ACR | `az acr login` |
| 21 | Retag and push images to ACR | `chatbot-backend:<version>`, `chatbot-frontend:<version>` |
| 22 | **Terraform apply — full** | Applies everything, with `revision_suffix = r<run_id>-<attempt>` to force a new Container App revision |
| 23 | Read Terraform outputs | chatbot URL, FQDN, signer URL and app name, resource group, Key Vault name, storage account and container names |
| 24 | Install docs-signer Function deps | `npm install --production` |
| 25 | **Deploy the Function code** | `Azure/functions-action@v1`. Terraform creates the Function App but does not deploy its code. |
| 26 | Upload deployment outputs | `outputs.json` artifact, including the Azure resource names |
| 27 | Notify platform — success / failure | Same as AWS, plus the Azure resource names |

**What step 22 creates:**

- **Resource group** `chatbot-<slug>`, holding every other resource.
- **ACR** (Basic) with the **admin user disabled**. The Container App pulls images as its user-assigned identity, which holds `AcrPull`. Pushes use `az acr login` with the deploying service principal and never needed the admin user.
- **Key Vault** (Standard) with a single inline access policy for the deploying service principal. It holds `llm-api-key`, `pinecone-api-key`, `docs-signer-secret` and `vector-db-url`.
- **Storage account for documents** (Standard LRS, TLS 1.2 minimum, nested public access off), with blob soft-delete for 30 days and CORS allowing `PUT` from the platform origin. It contains a private `documents` container.
- **Docs-signer Function App** on Linux, Consumption plan `Y1`, Node 20, with its **own runtime storage account** and a system-assigned identity. Its secret arrives as a plain app setting (see §5).
- **Two custom roles scoped to the docs storage account:**
  - The signer can call `generateUserDelegationKey` and write and delete blobs.
  - The chatbot can read the container and read blobs.
- **Log Analytics workspace** with 30-day retention, and a **Container Apps environment**.
- **One Container App** in `Single` revision mode with `min_replicas = 1` and `max_replicas = 3`:
  - The `chatbot` container has 0.5 vCPU / 1 Gi, with startup, readiness and liveness probes on `/api/health`. The probes are lenient because the embedding model loads slowly the first time.
  - The `frontend` container has 0.25 vCPU / 0.5 Gi. **nginx proxies `/api` to the backend over localhost**, because Container Apps cannot route by path.
  - External ingress goes to the frontend on port 80, and Azure provides TLS.
  - A **user-assigned identity**, created in the bootstrap apply, pulls the images and reads blobs. `AZURE_CLIENT_ID` tells `DefaultAzureCredential` which identity to use. No storage key and no registry password is used.
- **Vector store:** either a `pinecone_index`, or PostgreSQL Flexible Server 16 (`B_Standard_B1ms`, 32 GB) with the `VECTOR` extension allow-listed. It has **public network access with the "allow Azure services" firewall rule** (`0.0.0.0`), and its connection URL is stored in Key Vault.
- **How secrets reach containers:** as **Container App secrets whose values come straight from the Terraform variables**. The app does not read them from Key Vault.

### Phase D — Result

28. **Chatbot URL:**
    - Default → `https://<app>.<env>.<region>.azurecontainerapps.io`, with managed TLS.
    - With a `domain` set → `https://<domain>`. No custom domain or certificate is bound, so this URL will not work until one is (see §5).
29. **Redeploy** repeats steps 9–27. The new `revision_suffix` forces the app to pull the image tag again.
30. **Destroy is not available.** `triggerTenantDestroy` throws for any tenant that is not on AWS. An Azure tenant has to be removed by deleting its resource group by hand and removing the state file.

---

## 4. Comparison

### 4.1 Pipeline shape

| | AWS | Azure |
|---|---|---|
| Workflow | `deploy-tenant.yml` | `deploy-tenant-azure.yml` |
| Dispatch inputs | 17 inputs, **all non-secret** (ARNs only) | 9 inputs, **4 of them secret values**, settings in one JSON `config` |
| Credentials to the customer's cloud | GitHub OIDC → platform role → chained `sts:AssumeRole` into the tenant role (1 h cap) | Customer's long-lived service principal secret, passed as an input |
| Terraform version | pinned `1.9.5` | `~1.6` |
| Terraform applies | **1** | **2** (bootstrap `-target` RG+ACR, then full) |
| Registry created by | the workflow's CLI (`aws ecr create-repository`), outside Terraform | Terraform (bootstrap apply) |
| Steps outside Terraform | ECR repo creation, ECS service-linked role, Lambda `InvokeFunction` permission | Function code deployment (`functions-action`) |
| Function code packaged by | Terraform `archive_file` → `aws_lambda_function` | `Azure/functions-action` after apply |
| Rollout gate | ECS circuit breaker + rollback + `wait_for_steady_state` → bad image **fails** the run | Probes on the revision; no circuit breaker or steady-state wait is configured |
| Force-new-rollout on mutable tag | `force_new_deployment = true` | `revision_suffix = r<run_id>-<attempt>` |
| Job timeout | 45 min | 45 min |
| State key | `tenants/<slug>.tfstate` | `azure/tenants/<slug>/terraform.tfstate` (same S3 bucket) |
| Teardown workflow | `destroy-tenant.yml` | none |

### 4.2 Resource mapping

| Role | AWS | Azure |
|---|---|---|
| Isolation boundary | Dedicated VPC in the customer account | Dedicated resource group in the customer subscription |
| Image registry | ECR ×2 repos (scan on push), pulled via execution role | ACR Basic ×1, admin user disabled, pulled via user-assigned identity (`AcrPull`) |
| Compute | ECS Fargate: 2 services, 2 task definitions | Container Apps: 1 app, 2 containers in one replica |
| Backend size | 1 vCPU / 2 GB | 0.5 vCPU / 1 Gi |
| Frontend size | 0.25 vCPU / 0.5 GB | 0.25 vCPU / 0.5 Gi |
| Scaling | fixed `desired_count = 1` each | `min 1 / max 3` replicas (frontend and backend scale together) |
| Ingress / routing | ALB with path rule `/api/*` → backend | Managed ingress → frontend; nginx proxies `/api` over localhost |
| HTTPS | CloudFront by default, or ACM on the ALB with a custom domain | Built in on `*.azurecontainerapps.io` |
| Health checks | ALB target group health checks (30 s interval) | Startup / readiness / liveness probes per container |
| Documents store | S3 bucket, versioning + 30-day noncurrent expiry | Storage account + container, 30-day blob soft-delete |
| Browser upload | Presigned **POST** | User-delegation SAS **PUT** |
| Docs signer | Lambda + Function URL | Function App (Consumption Y1) + its own storage account |
| Signer permissions | IAM: `s3:PutObject`, `s3:DeleteObject` on prefix | Custom role: `generateUserDelegationKey`, blobs write/delete |
| Chatbot read access | Task role: `ListBucket` + `GetObject` | User-assigned identity + custom role: container read + blob read |
| Secrets store | Secrets Manager (written **by the platform** at onboarding) | Key Vault (written **by Terraform** at deploy) |
| Secret delivery to containers | `valueFrom` ARN, resolved at task start | Container App secret values set from TF vars |
| pgvector | RDS `db.t4g.micro`, private (SG from tasks only) | Flexible Server B1ms, public + "allow Azure services" |
| Logs | CloudWatch, 14 days | Log Analytics, 30 days |
| Slug length | 3–21 | 3–18 |

### 4.3 Secret handling

This is the largest difference between the two paths.

| Secret | AWS path | Azure path |
|---|---|---|
| LLM API key | Form → platform → **customer Secrets Manager** (once). Workflow and Terraform see only the ARN. | Form → platform DB (encrypted) → **decrypted and sent as a workflow input on every deploy** → TF variable → Key Vault **and** a Container App secret |
| Pinecone key | Stored in Secrets Manager; the workflow reads the value under the assumed role only to create the index | Same as the LLM key |
| Docs-signer secret | Generated, written to Secrets Manager, plus an encrypted platform copy; the Lambda reads it by ARN | Generated locally, stored encrypted, sent as an input on every deploy → Key Vault **and** a Function app setting |
| Cloud credential | None stored; the platform assumes a role for each operation | Service principal secret stored encrypted, sent as an input on every deploy |
| Present in Terraform state | ARNs; the pgvector password (generated) | LLM key, Pinecone key, signer secret, SP secret (as variables), pgvector password |

On AWS, secret values stay in the customer's account after onboarding. On Azure, they pass through GitHub Actions (masked) and Terraform state on every deploy. The reason is ordering: the Key Vault is created by the same deploy that needs it.

### 4.4 Cost (from `src/lib/pricing.ts`, us-east-1 / East US list prices, light traffic)

| Line | AWS (USD/mo) | Azure (USD/mo) |
|---|---|---|
| Backend compute | 36 | 39 |
| Frontend compute | 9 | 20 |
| Load balancer | 18–22 | — (included in ingress) |
| Registry | 1 | 5 |
| Secrets | 0.8 | 0.5 |
| Documents storage | 0.5–5 | 1–5 |
| Logs | 1–3 | 0–5 |
| **Total, Pinecone** | **≈ 66–77** | **≈ 66–75** |
| pgvector add-on | +16 | +17 |

Notes:

- Azure's compute figures are **before** the Container Apps free grant (180,000 vCPU-s + 360,000 GiB-s per subscription), which takes off about $5.40/month.
- Per unit of compute, Azure costs more at always-on usage. On AWS, the ALB's fixed cost makes up most of the difference.
- The estimator does not include CloudFront, the Lambda, the third Secrets Manager secret (docs signer), the Function App or its runtime storage account. All of these are small at light traffic, but the figures above slightly underestimate both clouds.
- Pinecone and the LLM API are billed separately by those providers.

### 4.5 Operational behaviour

| Scenario | AWS | Azure |
|---|---|---|
| New image is broken | Tasks fail health checks → circuit breaker rolls back → apply fails → deployment `failed` | New revision fails probes. The pipeline has no explicit check that ties this to the run's result. |
| Deploy with no custom TLS | HTTPS via CloudFront, but the ALB still serves plain HTTP on :80 | HTTPS only, no plaintext endpoint |
| Custom domain | Works when an ACM certificate ARN is also supplied | Accepted and reported as the URL, but **not bound** |
| Long reindex request | ALB idle timeout raised to 180 s | Container Apps ingress default applies |
| Callback to platform lost | Outputs recovered from the artifact; row reconciled from the run's conclusion | Same |
| Customer secret rotated | Update the Secrets Manager secret, then redeploy (new tasks read it) | Update in the platform (see `scripts/update-azure-tenant-secret.ts`), then redeploy |
| Offboarding | One click → `destroy-tenant.yml` | Manual |

---

## 5. Known asymmetries and gaps

These come straight from the code and its comments. They are useful as limitations or future work.

1. **The Lambda Function URL permission is set outside Terraform (AWS).** Since October 2025, Function URLs need a `lambda:InvokeFunction` statement with `InvokedViaFunctionUrl`. Provider `~> 5.60` cannot write that statement (the argument arrived in 6.28.0), so the workflow adds it through the CLI.
2. **Wrong source ECR region (AWS).** `deploy-tenant.yml` logs in to the platform's source ECR using `inputs.aws_region`, which is the *tenant's* region. If the tenant is in a different region from the platform ECR, the pull fails. The Azure workflow already reads the region from the image URI, and its comments call this "the exact latent bug" in the AWS workflow.
3. **Secret values go through CI on Azure** (§4.3). The Key Vault exists, but the app does not read from it at runtime. Its main use is as a copy the customer can see and rotate.
4. **Key Vault access policies cover the whole vault (Azure).** A policy cannot be limited to a single secret, so the docs-signer Function was deliberately given **no** vault access and gets its secret as an app setting. azurerm also rebuilds the policy list on every apply, which previously deleted a separately managed grant.
5. **ACR admin user (Azure) — resolved.** Images were pulled with a registry-wide admin password, whereas ECS uses a scoped IAM role. The admin user is now disabled, and the Container App pulls as a user-assigned identity holding `AcrPull`, created before the app so its first revision can pull. The docs-signer keeps its own separate identity.
6. **Azure pgvector networking.** The server uses public networking with the `0.0.0.0` "allow Azure services" rule. That rule blocks the general internet but allows traffic from **any** Azure-hosted source. On AWS the database is reachable only from the tenant's tasks. See `SECURITY.md`.
7. **Azure `chatbot_url` with a domain.** `outputs.tf` reports `https://<domain>`, but no custom domain or certificate is configured. The AWS output had the same bug and was fixed to report only a scheme the endpoint actually answers on.
8. **No rollout gate on Azure.** AWS turns a failed rollout into a failed deployment. Azure relies on revision probes and has no equivalent of the circuit breaker plus steady-state wait.
9. **No Azure teardown.** `triggerTenantDestroy` handles AWS only, and a misconfigured Azure tenant can only be fixed with the scripts in `scripts/`.
10. **Cross-cloud dependency.** Azure deploys still need AWS, for the S3 state bucket and the ECR source images. They no longer need a stored AWS key, since GitHub Actions reaches the platform role through OIDC, but an AWS outage or a broken OIDC trust still blocks Azure deployments too.
11. **AWS tasks run in public subnets** with public IPs to avoid NAT gateway costs, a trade-off the Terraform comments accept for the MVP. Azure Container Apps without VNet integration make a similar trade-off.

---

## 6. Summary

| Dimension | Simpler / stronger on | Why |
|---|---|---|
| Secret hygiene | **AWS** | Values written once into the customer account; only ARNs travel afterwards |
| Customer credential model | **AWS** | Short-lived assumed role vs a stored service principal secret |
| Deployment safety | **AWS** | Circuit breaker + steady-state wait fail the run on a bad rollout |
| Private data plane (pgvector) | **AWS** | Database reachable only from tasks |
| Lifecycle completeness | **AWS** | Automated teardown exists |
| HTTPS out of the box | **Azure** | Managed TLS, no CDN layer, no plaintext endpoint |
| Fewer moving parts | **Azure** | One Container App vs VPC + ALB + 2 services + CloudFront |
| Autoscaling | **Azure** | 1–3 replicas configured; AWS is fixed at 1 |
| Least-privilege document access | **Tie** | Both split write-only signer and read-only chatbot identities |
| Pipeline simplicity | **AWS** | One apply; Azure needs a bootstrap apply and a separate code deploy |
| Cost at one tenant | **Roughly equal** | ≈ $66–77 vs ≈ $66–75 per month before Azure's free grant |

In short, the AWS path is the more mature one. It has stronger isolation of secrets and credentials, a real rollout gate, and a full deploy-to-destroy lifecycle. The Azure path deploys fewer components and gets HTTPS and scaling from the platform itself. It pays for that with secrets passing through CI on every deploy, a two-phase apply, and no automated teardown.
