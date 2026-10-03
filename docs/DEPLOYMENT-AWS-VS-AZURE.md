# Deploying a Tenant Chatbot: AWS vs Azure

This document walks through what happens, step by step, when the platform deploys a tenant's chatbot to **AWS** and to **Azure**, and then compares the two paths.

It describes the system as the code implements it on 30 September 2026. The sources are:

| Concern | AWS | Azure |
|---|---|---|
| Customer setup | [`infra/bootstrap/aws/tenant-bootstrap.yaml`](../infra/bootstrap/aws/tenant-bootstrap.yaml) | [`infra/bootstrap/azure/tenant-bootstrap.json`](../infra/bootstrap/azure/tenant-bootstrap.json) |
| Onboarding (before dispatch) | [`src/app/tenants/new/actions.ts`](../src/app/tenants/new/actions.ts), [`src/lib/aws.ts`](../src/lib/aws.ts) | [`src/app/tenants/new/actions.ts`](../src/app/tenants/new/actions.ts), [`src/lib/azure.ts`](../src/lib/azure.ts) |
| Dispatch | [`src/lib/deploy.ts`](../src/lib/deploy.ts) `buildAwsInputs` | [`src/lib/deploy.ts`](../src/lib/deploy.ts) `buildAzureInputs` |
| Pipeline | [`.github/workflows/deploy-tenant.yml`](../.github/workflows/deploy-tenant.yml) | [`.github/workflows/deploy-tenant-azure.yml`](../.github/workflows/deploy-tenant-azure.yml) |
| Infrastructure | [`infra/terraform/`](../infra/terraform/) | [`infra/terraform/azure/`](../infra/terraform/azure/) |
| Document signer | [`infra/lambda/docs-signer/`](../infra/lambda/docs-signer/) | [`infra/azure-functions/docs-signer/`](../infra/azure-functions/docs-signer/) |
| Teardown | [`.github/workflows/destroy-tenant.yml`](../.github/workflows/destroy-tenant.yml) | [`.github/workflows/destroy-tenant-azure.yml`](../.github/workflows/destroy-tenant-azure.yml) |
| Cost model | [`src/lib/pricing.ts`](../src/lib/pricing.ts) | [`src/lib/pricing.ts`](../src/lib/pricing.ts) |

The customer-facing setup steps are covered in more detail in [`CLIENT-DEPLOYMENT-GUIDE.md`](../CLIENT-DEPLOYMENT-GUIDE.md). This document focuses on the deployment itself.

Related figures: [AWS credential model before](figures/fig-20-aws-credential-model-before.svg) and [after](figures/fig-21-aws-credential-model-after.svg), [Azure credential model before](figures/fig-22-azure-credential-model-before.svg) and [after](figures/fig-23-azure-credential-model-after.svg), [AWS pipeline](figures/fig-11-aws-deployment-pipeline.svg), [Azure pipeline](figures/fig-12-azure-deployment-pipeline.svg), [pipeline comparison](figures/fig-17-pipeline-comparison.svg), [AWS tenant infrastructure](figures/fig-04-aws-tenant-infrastructure.svg), [Azure tenant infrastructure](figures/fig-05-azure-tenant-infrastructure.svg), [secret flow](figures/fig-06-secret-flow.svg), [estimated cost](figures/fig-13-estimated-cost-by-cell.svg).

---

## 1. What both paths have in common

Both clouds follow the same model. The differences in section 4 are all variations on this.

1. **The platform is a control plane.** It stores tenant configuration and triggers deployments. The chatbot, its documents and its vector store run in the **customer's own** AWS account or Azure subscription.
2. **The customer's one-click setup creates the deployment identity.** A CloudFormation stack (AWS) or a subscription-level ARM deployment (Azure), both prefilled by the onboarding wizard, creates the identity deployments sign in as, its trust in GitHub for this one chatbot, and the storage for its Terraform state. The platform only builds the link; the customer approves it in their own console.
3. **No credential for the customer's cloud is stored anywhere.** Every deploy, teardown and connection check signs in with a token GitHub issues for that one run. The job runs in the GitHub environment `tenant-<tenant id>`, which GitHub writes into the token's subject, and the customer's identity trusts exactly that subject.
4. **One golden image, replicated per tenant.** The platform's ECR holds one backend image and one frontend (chat UI) image. Every deploy copies both into the tenant's own registry: ECR on AWS, ACR on Azure. Nothing is built from source per tenant.
5. **GitHub Actions runs the deploy.** The platform calls `workflow_dispatch` with the tenant's inputs. The workflow pushes the images and runs `terraform apply`.
6. **Terraform state, one file per tenant, in the customer's own cloud**, created by their setup and locked per run. On AWS it is a bucket in the account's regional namespace (`tfstate-<slug>-<account>-<region>-an`). On Azure it is a storage account in the chatbot's resource group (`cbtf<slug>`), reached through Entra ID. A deploy refuses to run if it is missing.
7. **Status comes back by webhook.** The workflow POSTs `running`, then `succeeded` or `failed`, to `PLATFORM_BASE_URL/api/deployments/<id>/status`, authenticated with `x-webhook-secret`. The Terraform outputs are also uploaded as a `deployment-outputs-<id>` artifact that is kept for 90 days, so the platform can recover them if the final callback is lost.
8. **The same runtime components on both clouds:** a backend container (port 8000, health check `/api/health`), a frontend nginx container (port 80), a private documents store, a docs-signer function that can write and delete documents but never read them, and a vector store. The vector store is either the customer's own Pinecone index (384-dim, cosine, AWS `us-east-1`) or managed Postgres with pgvector.
9. **The same LLM wiring.** `openai`, `anthropic` or `openrouter` sets `OPENAI_BASE_URL`, and `LLM_MODEL` is used when no model is given.
10. **The same onboarding checks.** Before anything reaches the customer's cloud, the server refuses a slug another tenant has used, a slug whose globally unique names someone outside the platform already holds, and a deployment identity another tenant already uses. The wizard asks the same questions as the operator types, and shows the one-click setup only once the slug is confirmed free.

### Operator prerequisites (shared)

| Kind | Name | Used by |
|---|---|---|
| Platform env | `PLATFORM_CHATBOT_IMAGE_URI`, `PLATFORM_FRONTEND_IMAGE_URI` (no tag) | `triggerDeployment`; without them, dispatch is refused |
| Platform env | `CHATBOT_DEPLOY_REF` (default `main`) | git ref the workflows run from |
| Platform env | `PLATFORM_BOOTSTRAP_TEMPLATE_BASE_URL` | where the published setup templates live (`infra/platform/bootstrap-templates`). Unset, the wizard offers only the manual setup |
| Platform env | `PLATFORM_AWS_ACCOUNT_ID` | the principal the AWS trust policy names for onboarding. Unset, the one-click AWS setup is hidden |
| Platform env | `AWS_PROFILE` (`platform-control-plane`) on a developer machine, or `PLATFORM_AWS_ROLE_ARN` on a host that signs its own OIDC token (Vercel) | onboarding's `sts:AssumeRole` into an AWS tenant's role. **No AWS access key is stored for the application**; see [`infra/platform/control-plane`](../infra/platform/control-plane/) |
| Platform env | `DEPLOY_WEBHOOK_SECRET` | checks the status callbacks; must equal the GitHub secret below |
| GitHub variable | `AWS_PLATFORM_DEPLOY_ROLE_ARN` | the platform role GitHub Actions reaches through OIDC, used only to pull the golden images. It can assume no customer role. **No AWS access key is stored in GitHub**; see [`infra/platform/github-oidc`](../infra/platform/github-oidc/) |
| GitHub secret | `PLATFORM_BASE_URL`, `PLATFORM_WEBHOOK_SECRET` | status callbacks, the Azure runs' secret fetch, and the CORS origin for document uploads |
| GitHub variable | `EXTRA_CORS_ORIGIN` (optional) | a second upload origin, e.g. `http://localhost:3000` for a control plane on a developer machine |

---

## 2. AWS deployment, step by step

### Phase A — Customer setup (in their AWS account)

1. **Get the account ID and choose a region**, then start the onboarding form and choose a slug. The form confirms the slug is free before it shows the setup.
2. **Create the bootstrap stack** from the wizard's **Configure AWS account** link: a CloudFormation Quick Create page with every parameter filled in. The stack `chatbot-bootstrap-<slug>` creates:
   - GitHub registered as an OIDC identity provider, unless the account already has one, in which case the wizard's checkbox sets `CreateGitHubOidcProvider=No` and the stack reuses it
   - the role `chatbot-client-deploy-<slug>`, with a one-hour maximum session
   - a trust policy with two statements: `GitHubActionsDeploy` (`sts:AssumeRoleWithWebIdentity` for subject `repo:<owner>/<repo>:environment:tenant-<tenant id>`, audience `sts.amazonaws.com`) and `PlatformOnboarding` (`sts:AssumeRole` from the platform account, conditioned on `sts:ExternalId` = the tenant ID)
   - the permissions Terraform needs: `ec2`, `elasticloadbalancing`, `ecs`, `ecr`, `s3`, `lambda`, `secretsmanager`, `logs`, `rds`, `cloudfront`, plus a limited set of IAM actions for creating task and Lambda roles
   - the state bucket `tfstate-<slug>-<account>-<region>-an`: versioned, private, TLS-only, superseded versions expiring after 30 days
3. **Copy `DeploymentRoleArn`** from the stack's outputs into the form, and optionally press **Test connection** (`verify-tenant-aws.yml`), which signs in as a deploy would and checks the state bucket.
4. **Get the LLM API key, and the Pinecone key if using Pinecone.**
5. *(Optional)* **Request an ACM certificate** for a custom hostname, in the same region, validated through DNS.

The role must be named `chatbot-client-deploy-*` even when built by hand: the platform's own role may assume no other.

### Phase B — Onboarding (platform server action `createTenantAndDeploy`)

6. **The form is validated** (`TenantInput`). The slug must be 3–21 characters, because the frontend target group is named `chatbot-<slug>-ui` and AWS caps that at 32.
7. **The slug and the role are checked** before any cloud call: the slug against every tenant, live or deleted, and against S3 (the documents bucket `chatbot-<slug>-docs` must not exist anywhere); the role ARN against every other tenant's.
8. **The platform assumes the tenant role** with STS for a 15-minute session, sending the tenant ID as `ExternalId`.
9. **The platform writes the secrets into the customer's Secrets Manager:**
   - `<slug>/llm-api-key`
   - `<slug>/pinecone-api-key` (Pinecone only)
   - `<slug>/docs-signer-secret`, a random 32-byte value (`ensureDocsSignerSecret`)

   Only the **ARNs** are kept for the deploy. The platform also keeps its own encrypted copy of the docs-signer secret, because it sends that secret with every document operation. This is the only time the platform itself signs in to the customer's account.
10. **The tenant row is inserted** under the wizard's tenant ID, and `triggerDeployment` runs. It creates a `deployments` row with status `pending` and dispatches `deploy-tenant.yml` with the 20 inputs from `buildAwsInputs`. These are all plain strings, and **no secret values are included**. The row then moves to `running`.

### Phase C — Pipeline (`deploy-tenant.yml`, 45-minute timeout)

| # | Step | What happens |
|---|---|---|
| — | Job environment | `tenant-<tenant_id>`: puts the tenant into the OIDC token's `sub` claim |
| 11 | Notify platform — run started | POSTs `running` with the run ID and URL. Any response other than HTTP 200 marks the step as failed, but the step is `continue-on-error`. |
| 12 | Checkout | |
| 13 | Configure AWS credentials (platform role via OIDC) | Exchanges GitHub's signed OIDC token for one-hour credentials on the platform role, used only to read the source ECR. No stored key. |
| 14 | Pull source images | `docker pull` of the backend and frontend images. The ECR login uses the region in the image URI, not the tenant's. |
| 15 | Configure AWS credentials (tenant role via OIDC) | **A second, independent OIDC exchange** into `deployment_role_arn`, with the platform credentials unset first. The customer's role trusts GitHub directly for this tenant's subject; the platform account is not a principal in this sign-in. One-hour session. |
| 16 | Replicate images to client ECR | Creates `<slug>/chatbot` and `<slug>/chatbot-frontend` if missing (scan on push), then tags and pushes `:<chatbot_version>`. Each push is retried up to three times. |
| 17 | Ensure ECS service-linked role | Idempotent `iam create-service-linked-role` |
| 18 | Terraform init | Terraform 1.15.3 through `.github/scripts/terraform-init-aws.sh`: the customer's own bucket, key `terraform.tfstate`, S3 lock file. A bucket that is missing or owned by another account stops the run |
| 19 | Read customer Pinecone key | Pinecone only: reads the value from **the customer's** Secrets Manager under the tenant role and masks it |
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
  - CORS allows `POST` from `PLATFORM_BASE_URL` and, if set, `EXTRA_CORS_ORIGIN`
- **Docs-signer Lambda** (Node 20, 128 MB) behind a Function URL with `authorization_type = NONE`. Authentication is the shared-secret header checked inside the handler.
- **CloudWatch log groups** with 14-day retention.
- **Vector store:** either a `pinecone_index`, or RDS Postgres 16 (`db.t4g.micro`, 20 GB gp3, encrypted, not publicly accessible, security group allows only the tasks) with its connection URL stored in Secrets Manager.
- **Secrets reach containers through ECS `secrets.valueFrom`.** The value is resolved at task start and never appears in Terraform variables or GitHub inputs.

### Phase D — Result

26. **Chatbot URL**, chosen by `outputs.tf`:
    - A certificate and domain → `https://<domain>`
    - Otherwise CloudFront → `https://<id>.cloudfront.net`
    - Otherwise → `http://<alb-dns>`
27. **Redeploy** repeats steps 10–25. `force_new_deployment` makes ECS pull the mutable tag again.
28. **Destroy** (`destroy-tenant.yml`, 60-minute timeout):
    1. The platform deletes the documents through the signer, best effort.
    2. The run signs in to the tenant role through OIDC, as a deploy does, and empties the bucket, including all object versions. The session starts in the job's first minute and lasts an hour, which is why the 60-minute timeout must not be raised without refreshing credentials.
    3. `terraform destroy` runs.
    4. The two ECR repositories and the Secrets Manager secrets written at onboarding are deleted.
    5. The run reports what the customer still owns: the bootstrap stack, whose deletion revokes the platform's access, and the state bucket, which the stack keeps on purpose.

---

## 3. Azure deployment, step by step

### Phase A — Customer setup (in their Azure subscription)

1. **Get the subscription ID and the Entra tenant ID**, choose a region, then start the onboarding form and choose a slug. The form confirms the slug is free before it shows the setup.
2. **Run the setup deployment** from the wizard's **Configure Azure** button (the portal's custom-deployment blade) or with the `az deployment sub create` command the wizard shows with every value filled in, including `--subscription`. The portal takes no values from a link, so the wizard lists them under the labels the portal shows: `Chatbot Id` (the tenant ID, not the Entra tenant ID), `Chatbot Slug`, `Git Hub Owner`, `Git Hub Repo`, `Location`. The subscription-level template creates:
   - the resource group `chatbot-<slug>`
   - a user-assigned managed identity `chatbot-deploy-<slug>`, which needs no Entra ID permission to create
   - a federated credential on it: issuer `https://token.actions.githubusercontent.com`, audience `api://AzureADTokenExchange`, subject `repo:<owner>/<repo>:environment:tenant-<tenant id>`
   - `Contributor` and `User Access Administrator` on that resource group only. The second is needed because Terraform creates custom role definitions and assigns roles
   - the state storage account `cbtf<slug>` with container `tfstate`: no Shared Key access, versioned, superseded versions expiring after 30 days, and `Storage Blob Data Contributor` for the identity on that one container
3. **Copy `clientId`** from the deployment's outputs into the form, and optionally press **Test connection** (`verify-tenant-azure.yml`), which exchanges a token as a deploy would, checks the resource group and the state storage, and explains the common Entra sign-in errors.
4. **Get the LLM API key, and the Pinecone key if using Pinecone.**

Running the setup again for an existing chatbot is safe: every resource is declared by name, so it adds what is missing and leaves the rest.

### Phase B — Onboarding (platform server action `createTenantAndDeploy`)

5. **The form is validated.** The slug must be **3–18 characters**, because Key Vault names are limited to 24 characters and the vault is named `cb-<slug>-kv`.
6. **The slug and the client ID are checked** before anything is stored: the slug against every tenant, live or deleted; against every live Azure tenant's derived names, since Azure drops hyphens from storage and registry names and shortens them, so two distinct slugs can need the same name; and against DNS, for the names Azure must hold globally (documents and function storage accounts, registry, Key Vault, function app, Postgres server). The client ID is checked against every other tenant's.
7. **No call is made to the customer's cloud.** The customer's Key Vault does not exist yet: Terraform creates it during the deploy. Instead the platform:
   - encrypts the LLM key and the Pinecone key (AES-256-GCM in the platform database). There is no Azure credential to store.
   - generates the docs-signer secret locally (`generateDocsSignerSecret`) and stores it encrypted
8. **The tenant row is inserted under the wizard's tenant ID** and `triggerDeployment` dispatches `deploy-tenant-azure.yml` with the 6 inputs from `buildAzureInputs`:
   - Non-secret settings are packed into a single JSON `config` input, a workaround from when `workflow_dispatch` allowed only 10 inputs.
   - `tenant_id` names the job's GitHub environment, and so the OIDC subject.
   - **No secret is an input.** GitHub records inputs in the run's event payload, so the run fetches the LLM key, Pinecone key and docs-signer secret from the platform itself, proving with its GitHub OIDC token that it is this tenant's deploy (see "Credentials in Transit" in `SECURITY.md`).

### Phase C — Pipeline (`deploy-tenant-azure.yml`, 45-minute timeout)

| # | Step | What happens |
|---|---|---|
| — | Job environment | `tenant-<tenant_id>`: puts the tenant into the OIDC token's `sub` claim |
| 9 | Notify platform — run started | Same as AWS |
| 10 | Fetch tenant secrets from the platform | `POST PLATFORM_BASE_URL/api/deployments/<id>/secrets` with the run's OIDC token. Released once per deployment, masked, and written to a runner file for Terraform, not to the environment |
| 11 | Parse tenant config | `jq` checks the IDs are present and applies defaults: region `eastus`, version `latest`, vector store `pinecone` |
| 12 | Checkout | |
| 13 | Compute resource names | ACR name `chatbot<slug-without-hyphens>`. The source ECR region is **read from the image URI**, not taken from the tenant's region. |
| 14 | Configure AWS credentials (platform role via OIDC) | Same OIDC platform role as AWS. Its credentials pull from the source ECR, and are used for nothing else. |
| 15 | Pull source images | Same golden images as AWS |
| 16 | Azure login | `azure/login@v2` with **no secret**: the job's GitHub OIDC token is exchanged through the customer's federated credential. Refused here, before anything is created, if the credential is missing or names another subject; the failure callback reports the expected subject. Terraform authenticates the same way (`use_oidc = true`, `use_cli = false`), on both its providers. |
| 17 | Terraform init | Terraform 1.15.3 through `.github/scripts/terraform-init-azure.sh`: **azurerm** backend on the customer's storage account `cbtf<slug>` (container `tfstate`), looked up in the chatbot's resource group first, reached through Entra ID with the run's OIDC token, locked with a blob lease. A missing account or container, or one the identity cannot read, stops the run |
| 18 | **Terraform apply — bootstrap** | `-target` the ACR, the chatbot's **user-assigned identity** and its **`AcrPull`** grant, with placeholder image URIs. The registry must exist before images are pushed, and the identity must hold `AcrPull` before the app's first revision pulls. The resource group is read, never targeted: the customer's setup created it. |
| 19 | Allow the AcrPull grant to propagate | A fixed 90-second pause |
| 20 | Log in to ACR | `az acr login` |
| 21 | Retag and push images to ACR | `chatbot-backend:<version>`, `chatbot-frontend:<version>`. Each push is retried up to three times, with a growing pause. |
| 22 | **Terraform apply — full** | Applies everything, with `revision_suffix = r<run_id>-<attempt>` to force a new Container App revision |
| 23 | Remove tenant secrets from the runner | Always runs, so later steps, including third-party actions, never see them |
| 24 | Read Terraform outputs | chatbot URL, FQDN, signer URL and app name, resource group, Key Vault name, storage account and container names |
| 25 | Install docs-signer Function deps | `npm install --production` |
| 26 | **Deploy the Function code** | `Azure/functions-action@v1`. Terraform creates the Function App but does not deploy its code. |
| 27 | Upload deployment outputs | `outputs.json` artifact, including the Azure resource names |
| 28 | Notify platform — success / failure | Same as AWS, plus the Azure resource names |

**What step 22 creates**, all inside the resource group the customer's setup created:

- **ACR** (Basic) with the **admin user disabled**. The Container App pulls images as its user-assigned identity, which holds `AcrPull`. Pushes use `az acr login` with the deploying identity's federated login and never needed the admin user.
- **Key Vault** (Standard) with a single inline access policy for the deploying identity. It holds `llm-api-key`, `pinecone-api-key`, `docs-signer-secret` and `vector-db-url`. On destroy its secrets are purged and the vault is only soft-deleted: purging a vault is a subscription-level action the deploying identity does not have.
- **Storage account for documents** (Standard LRS, TLS 1.2 minimum, nested public access off, **no Shared Key authorization**), with blob soft-delete for 30 days and CORS allowing `PUT` from `PLATFORM_BASE_URL` and, if set, `EXTRA_CORS_ORIGIN`. It contains a private `documents` container.
- **Docs-signer Function App** on Linux, Consumption plan `Y1`, Node 20, with its **own runtime storage account** and a system-assigned identity. Its secret arrives as a plain app setting (see §5).
- **Two custom roles scoped to the docs storage account:**
  - The signer can call `generateUserDelegationKey` and write and delete blobs.
  - The chatbot can read the container and read blobs.
- **Log Analytics workspace** with 30-day retention, and a **Container Apps environment** `chatbot-<slug>-cae`. It is declared through the `azapi` provider with `environmentMode = "WorkloadProfiles"` and only the Consumption profile, because azurerm cannot set the mode and an environment left to Azure's default was created as **Express**, which refuses sidecar containers, health probes and revision suffixes.
- **One Container App** in `Single` revision mode on the Consumption profile, with `min_replicas = 1` and `max_replicas = 3`:
  - The `chatbot` container has 0.5 vCPU / 1 Gi, with startup, readiness and liveness probes on `/api/health`. The probes are lenient because the embedding model loads slowly the first time.
  - The `frontend` container has 0.25 vCPU / 0.5 Gi. **nginx proxies `/api` to the backend over localhost**, because Container Apps cannot route by path.
  - External ingress goes to the frontend on port 80, and Azure provides TLS.
  - A **user-assigned identity**, created in the bootstrap apply, pulls the images and reads blobs. `AZURE_CLIENT_ID` tells `DefaultAzureCredential` which identity to use. No storage key and no registry password is used.
- **Vector store:** either a `pinecone_index`, or PostgreSQL Flexible Server 16 (`B_Standard_B1ms`, 32 GB) with the `VECTOR` extension allow-listed. It has **public network access with the "allow Azure services" firewall rule** (`0.0.0.0`), and its connection URL is stored in Key Vault.
- **How secrets reach containers:** as **Container App secrets whose values come straight from the Terraform variables**. The app does not read them from Key Vault.

### Phase D — Result

29. **Chatbot URL:**
    - Default → `https://<app>.<env>.<region>.azurecontainerapps.io`, with managed TLS.
    - With a `domain` set → `https://<domain>`. No custom domain or certificate is bound, so this URL will not work until one is (see §5).
30. **Redeploy** repeats steps 8–28. The new `revision_suffix` forces the app to pull the image tag again.
31. **Destroy** (`destroy-tenant-azure.yml`, 45-minute timeout):
    1. The platform deletes the documents through the signer, best effort.
    2. The run fetches the Pinecone key from the platform the same way a deploy does, because destroying the index calls Pinecone's own API.
    3. It signs in through the federated credential and runs `terraform destroy`, which empties the resource group of everything Terraform created. Azure deletes a storage account together with its contents, so no separate emptying step is needed, and the deploying identity could not do one anyway: it holds no data role on the documents.
    4. The run reports what the customer still owns: the resource group, the deployment identity and the state storage account. Deleting the resource group removes all three and revokes the platform's access.

---

## 4. Comparison

### 4.1 Pipeline shape

| | AWS | Azure |
|---|---|---|
| Customer setup | CloudFormation stack (Quick Create link) | Subscription-level ARM deployment (portal or `az`) |
| Deploy identity | IAM role `chatbot-client-deploy-<slug>` | User-assigned managed identity `chatbot-deploy-<slug>` |
| Its scope | The permissions policy, account-wide | `Contributor` + `User Access Administrator` on one resource group |
| Workflow | `deploy-tenant.yml` | `deploy-tenant-azure.yml` |
| Dispatch inputs | 20 inputs, **all non-secret** (ARNs only) | 6 inputs, **all non-secret**, settings in one JSON `config`. Secrets fetched by the run from the platform |
| Credentials to the customer's cloud | GitHub OIDC (per-tenant environment subject) → `sts:AssumeRoleWithWebIdentity` into the tenant role (1 h). Nothing stored | GitHub OIDC (per-tenant environment subject) → customer's federated credential → Entra access token. Nothing stored |
| Platform's own sign-in to the customer | Once, at onboarding, to write secrets (`ExternalId` = tenant ID) | Never |
| Terraform version | pinned `1.15.3` | pinned `1.15.3` |
| Terraform providers (cloud) | `aws ~> 5.60` | `azurerm ~> 3.110`, plus `azapi ~> 2.0` for the Container Apps environment |
| Terraform applies | **1** | **2** (bootstrap `-target` ACR + identity + `AcrPull`, then full) |
| Registry created by | the workflow's CLI (`aws ecr create-repository`), outside Terraform | Terraform (bootstrap apply) |
| Steps outside Terraform | ECR repo creation, ECS service-linked role, Lambda `InvokeFunction` permission | Function code deployment (`functions-action`) |
| Function code packaged by | Terraform `archive_file` → `aws_lambda_function` | `Azure/functions-action` after apply |
| Rollout gate | ECS circuit breaker + rollback + `wait_for_steady_state` → bad image **fails** the run | Probes on the revision; no circuit breaker or steady-state wait is configured |
| Force-new-rollout on mutable tag | `force_new_deployment = true` | `revision_suffix = r<run_id>-<attempt>` |
| Image push | Retried up to 3 times | Retried up to 3 times |
| Job timeout | 45 min | 45 min |
| State location | Customer's own bucket `tfstate-<slug>-<account>-<region>-an`, key `terraform.tfstate` | Customer's own storage account `cbtf<slug>`, container `tfstate`, key `terraform.tfstate` |
| Teardown workflow | `destroy-tenant.yml` (60 min) | `destroy-tenant-azure.yml` (45 min) |
| Left for the customer after teardown | Bootstrap stack (with its role) and state bucket | Resource group, deployment identity and state storage account |

### 4.2 Resource mapping

| Role | AWS | Azure |
|---|---|---|
| Isolation boundary | Dedicated VPC in the customer account | Dedicated resource group in the customer subscription |
| Image registry | ECR ×2 repos (scan on push), pulled via execution role | ACR Basic ×1, admin user disabled, pulled via user-assigned identity (`AcrPull`) |
| Compute | ECS Fargate: 2 services, 2 task definitions | Container Apps (workload-profiles environment, Consumption profile): 1 app, 2 containers in one replica |
| Backend size | 1 vCPU / 2 GB | 0.5 vCPU / 1 Gi |
| Frontend size | 0.25 vCPU / 0.5 GB | 0.25 vCPU / 0.5 Gi |
| Scaling | fixed `desired_count = 1` each | `min 1 / max 3` replicas (frontend and backend scale together) |
| Ingress / routing | ALB with path rule `/api/*` → backend | Managed ingress → frontend; nginx proxies `/api` over localhost |
| HTTPS | CloudFront by default, or ACM on the ALB with a custom domain | Built in on `*.azurecontainerapps.io` |
| Health checks | ALB target group health checks (30 s interval) | Startup / readiness / liveness probes per container |
| Documents store | S3 bucket, versioning + 30-day noncurrent expiry | Storage account + container, 30-day blob soft-delete |
| Browser upload | Presigned **POST** | User-delegation SAS **PUT** |
| Upload origins allowed (CORS) | `PLATFORM_BASE_URL` + optional `EXTRA_CORS_ORIGIN` | Same |
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
| LLM API key | Form → platform → **customer Secrets Manager** (once). Workflow and Terraform see only the ARN. | Form → platform DB (encrypted) → **released once per deploy to the run that proves, by OIDC token, it is this tenant's deploy workflow** → TF variable → Key Vault **and** a Container App secret |
| Pinecone key | Stored in Secrets Manager; the workflow reads the value under the tenant role only to create the index | Same as the LLM key; a teardown fetches it too, to delete the index |
| Docs-signer secret | Generated, written to Secrets Manager, plus an encrypted platform copy; the Lambda reads it by ARN | Generated locally, stored encrypted, released to the deploy run the same way → Key Vault **and** a Function app setting |
| Cloud credential | None stored. Deploys federate through GitHub OIDC; the platform assumes the role only at onboarding | None stored. Each run federates through the customer's credential, which trusts that tenant only |
| Present in Terraform state | ARNs; the pgvector password (generated). Kept in the customer's own account | LLM key, Pinecone key, signer secret (as Key Vault secret values), pgvector password, the Log Analytics workspace keys. Kept in the customer's own subscription |

On AWS, secret values stay in the customer's account after onboarding. On Azure, the deploy run fetches them from the platform, which releases them once, to that tenant's own run, on proof of its OIDC subject. Terraform then writes them, so they also sit in Terraform state, which is kept in the customer's own subscription. The reason for the difference is ordering: on Azure the Key Vault is created by the same deploy that needs it.

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
| pgvector add-on | +14 | +17 |

Notes:

- Azure's compute figures are **before** the Container Apps free grant (180,000 vCPU-s + 360,000 GiB-s per subscription), which takes off about $5.40/month. A workload-profiles environment with only the Consumption profile is billed the same way and gets the same grant; the management fee applies to Dedicated profiles, and none is declared.
- Per unit of compute, Azure costs more at always-on usage. On AWS, the ALB's fixed cost makes up most of the difference.
- The estimator does not include CloudFront, the Lambda, the third Secrets Manager secret (docs signer), the Function App or its runtime storage account, or either cloud's state storage. All of these are small at light traffic, but the figures above slightly underestimate both clouds.
- Pinecone and the LLM API are billed separately by those providers.

### 4.5 Operational behaviour

| Scenario | AWS | Azure |
|---|---|---|
| New image is broken | Tasks fail health checks → circuit breaker rolls back → apply fails → deployment `failed` | New revision fails probes. The pipeline has no explicit check that ties this to the run's result. |
| Deploy with no custom TLS | HTTPS via CloudFront, but the ALB still serves plain HTTP on :80 | HTTPS only, no plaintext endpoint |
| Custom domain | Works when an ACM certificate ARN is also supplied | Accepted and reported as the URL, but **not bound** |
| Long reindex request | ALB idle timeout raised to 180 s; the platform bypasses CloudFront for it | Container Apps ingress default applies |
| Registry refuses one connection | The push is retried | The push is retried |
| Callback to platform lost | Outputs recovered from the artifact; row reconciled from the run's conclusion | Same |
| Platform unreachable during the run | Deploy still finishes; its outcome is recorded when reconciled | Deploy fails at the secret fetch |
| Customer identity replaced | Update the role ARN, then redeploy | Point the tenant at the new identity (`scripts/update-azure-tenant-identity.ts`), then redeploy. No secret to rotate |
| Offboarding | One click → `destroy-tenant.yml` | One click → `destroy-tenant-azure.yml` |

---

## 5. Known asymmetries and gaps

These come straight from the code and its comments. They are useful as limitations or future work.

1. **The Lambda Function URL permission is set outside Terraform (AWS).** Since October 2025, Function URLs need a `lambda:InvokeFunction` statement with `InvokedViaFunctionUrl`. Provider `~> 5.60` cannot write that statement (the argument arrived in 6.28.0), so the workflow adds it through the CLI.
2. **Wrong source ECR region (AWS) — resolved.** `deploy-tenant.yml` used to log in to the platform's source ECR with the *tenant's* region, which failed every tenant outside the platform's region. It now reads the region from the image URI, as the Azure workflow always did.
3. **Secret values go through CI on Azure** (§4.3). The Key Vault exists, but the app does not read from it at runtime. Its main use is as a copy the customer can see and rotate.
4. **Key Vault access policies cover the whole vault (Azure).** A policy cannot be limited to a single secret, so the docs-signer Function was deliberately given **no** vault access and gets its secret as an app setting. azurerm also rebuilds the policy list on every apply, which previously deleted a separately managed grant.
5. **ACR admin user (Azure) — resolved.** Images were pulled with a registry-wide admin password, whereas ECS uses a scoped IAM role. The admin user is now disabled, and the Container App pulls as a user-assigned identity holding `AcrPull`, created before the app so its first revision can pull. The docs-signer keeps its own separate identity.
6. **Azure pgvector networking.** The server uses public networking with the `0.0.0.0` "allow Azure services" rule. That rule blocks the general internet but allows traffic from **any** Azure-hosted source. On AWS the database is reachable only from the tenant's tasks. See `SECURITY.md`.
7. **Azure `chatbot_url` with a domain.** `outputs.tf` reports `https://<domain>`, but no custom domain or certificate is configured. The AWS output had the same bug and was fixed to report only a scheme the endpoint actually answers on.
8. **No rollout gate on Azure.** AWS turns a failed rollout into a failed deployment. Azure relies on revision probes and has no equivalent of the circuit breaker plus steady-state wait.
9. **No Azure teardown — resolved.** `destroy-tenant-azure.yml` runs `terraform destroy` under the same federated sign-in as a deploy. It leaves the resource group, the identity and the state storage for the customer, as the AWS teardown leaves the stack and the state bucket.
10. **Cross-cloud dependency.** Azure deploys still need AWS for the ECR source images. They need no stored AWS key, since GitHub Actions reaches the platform role through OIDC, but an AWS outage or a broken OIDC trust still blocks Azure deployments too. Azure state itself does not depend on AWS.
11. **AWS tasks run in public subnets** with public IPs to avoid NAT gateway costs, a trade-off the Terraform comments accept for the MVP. Azure Container Apps without VNet integration make a similar trade-off.
12. **Azure's defaults can change underneath the configuration.** The Container Apps environment used to be declared without a mode, and Azure created it as Express, which refuses this app. The mode is now stated explicitly, and API 2026-07-01 is used because it is the first stable version with the property; `azapi`'s local schema check is off for that one resource until its bundled schemas include it.
13. **Fresh Azure subscriptions may lack registered resource providers.** The deploying identity's roles stop at the resource group, so it cannot register a provider (`skip_provider_registration = true`), and a first deploy into a subscription that has never used, for example, Container Apps fails until the customer registers it.

---

## 6. Summary

| Dimension | Simpler / stronger on | Why |
|---|---|---|
| Secret hygiene | **AWS** | Values written once into the customer account; only ARNs travel afterwards |
| Customer credential model | **Tie** | Neither holds a customer credential: every run federates through GitHub OIDC into an identity that trusts that tenant only |
| Scope of the deploy identity | **Azure** | Its roles stop at the chatbot's resource group; the AWS role's permissions are account-wide |
| Deployment safety | **AWS** | Circuit breaker + steady-state wait fail the run on a bad rollout |
| Private data plane (pgvector) | **AWS** | Database reachable only from tasks |
| Lifecycle completeness | **Tie** | Both have one-click setup, deploy, connection check and teardown |
| HTTPS out of the box | **Azure** | Managed TLS, no CDN layer, no plaintext endpoint |
| Fewer moving parts | **Azure** | One Container App vs VPC + ALB + 2 services + CloudFront |
| Autoscaling | **Azure** | 1–3 replicas configured; AWS is fixed at 1 |
| Least-privilege document access | **Tie** | Both split write-only signer and read-only chatbot identities |
| Pipeline simplicity | **AWS** | One apply; Azure needs a bootstrap apply, a propagation wait and a separate code deploy |
| Independence from the control plane at deploy time | **AWS** | An Azure deploy needs the platform reachable to fetch its secrets |
| Cost at one tenant | **Roughly equal** | ≈ $66–77 vs ≈ $66–75 per month before Azure's free grant |

In short, the AWS path is the more mature one. It keeps secrets out of CI, has a real rollout gate, and needs one Terraform apply. The Azure path deploys fewer components, confines its deploy identity to one resource group, and gets HTTPS and scaling from the platform itself. It pays for that with secrets passing through CI on every deploy, a two-phase apply, and a deploy that depends on the control plane being reachable.
