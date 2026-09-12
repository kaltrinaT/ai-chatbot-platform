# Client Deployment Guide

This is a step-by-step guide for a **client (tenant)** onboarding onto the AI Chatbot Platform. It covers everything you need to have ready in your own AWS or Azure account **before** filling out the onboarding form, plus what to expect afterward.

> This platform is a control plane only — it never sees your documents, chat queries, or answers. Everything below happens inside **your own cloud account**. See `ARCHITECTURE.md` and `SECURITY.md` for the full trust model.

---

## Before you start: pick your cloud and your vector store

| Choice | Options |
|---|---|
| Cloud provider | AWS or Azure |
| LLM provider | OpenAI, Anthropic, or OpenRouter |
| Vector store | Customer-owned Pinecone, **or** a Postgres + pgvector database provisioned inside your own cloud account |

If you're unsure on vector store: Pinecone is cheaper and needs nothing extra from you besides an API key, but your embeddings leave your cloud account for Pinecone's own infrastructure (always in AWS `us-east-1`, regardless of where your chatbot itself runs). pgvector costs a small amount more (~$16–17/month) but keeps everything inside your own account.

---

## Path A — AWS

### 1. Get your account ID and pick a region
- Console: click your account name (top-right) → copy the 12-digit account ID.
- CLI: `aws sts get-caller-identity --query Account --output text`
- Pick the AWS region you want your chatbot infrastructure to run in (e.g. `us-east-1`, `eu-west-1`).

### 2. Create the IAM role the platform will assume

**IAM → Roles → Create role → Custom trust policy.**

Trust policy — paste exactly this (replace `PLATFORM_ACCOUNT_ID` with the value the platform operator gives you):
```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": { "AWS": "arn:aws:iam::PLATFORM_ACCOUNT_ID:root" },
      "Action": "sts:AssumeRole"
    }
  ]
}
```
⚠️ **Do not add an `sts:ExternalId` condition.** The platform's `AssumeRole` call does not send one — a trust policy that requires it will make every deploy fail with `AccessDenied`.

### 3. Name the role correctly — this is required, not cosmetic
**The role name must start with `chatbot-client-deploy-`** (e.g. `chatbot-client-deploy-acme`). The platform's own AWS identity is restricted by its own IAM policy to only assume roles matching `arn:aws:iam::*:role/chatbot-client-deploy-*` — any other name is denied before your trust policy is even evaluated, regardless of how correctly it's configured.

### 4. Attach the permissions policy
This role needs to create everything Terraform provisions on your behalf: a VPC, an Application Load Balancer, an ECS cluster with two Fargate services, two ECR repos, an S3 documents bucket, a per-tenant docs-signer Lambda (for the platform's document upload/delete UI — see `DOCUMENT-MANAGEMENT.md`), a CloudWatch log group, IAM roles for the ECS tasks and the Lambda, Secrets Manager secrets, a CloudFront distribution (unless you bring your own TLS certificate — see step 7b), and (if you chose pgvector) an RDS instance.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Sid": "Networking", "Effect": "Allow", "Action": "ec2:*", "Resource": "*" },
    { "Sid": "LoadBalancer", "Effect": "Allow", "Action": "elasticloadbalancing:*", "Resource": "*" },
    { "Sid": "Compute", "Effect": "Allow", "Action": "ecs:*", "Resource": "*" },
    { "Sid": "Images", "Effect": "Allow", "Action": "ecr:*", "Resource": "*" },
    { "Sid": "Storage", "Effect": "Allow", "Action": "s3:*", "Resource": "*" },
    { "Sid": "Functions", "Effect": "Allow", "Action": "lambda:*", "Resource": "*" },
    { "Sid": "Secrets", "Effect": "Allow", "Action": "secretsmanager:*", "Resource": "*" },
    { "Sid": "Logs", "Effect": "Allow", "Action": "logs:*", "Resource": "*" },
    { "Sid": "Database", "Effect": "Allow", "Action": "rds:*", "Resource": "*" },
    { "Sid": "Cdn", "Effect": "Allow", "Action": "cloudfront:*", "Resource": "*" },
    {
      "Sid": "IamForTaskRoles",
      "Effect": "Allow",
      "Action": [
        "iam:CreateRole", "iam:DeleteRole", "iam:GetRole",
        "iam:AttachRolePolicy", "iam:DetachRolePolicy",
        "iam:PutRolePolicy", "iam:DeleteRolePolicy", "iam:GetRolePolicy",
        "iam:ListRolePolicies", "iam:ListAttachedRolePolicies",
        "iam:ListInstanceProfilesForRole",
        "iam:TagRole", "iam:PassRole", "iam:CreateServiceLinkedRole"
      ],
      "Resource": "*"
    }
  ]
}
```
> **Why `s3:*`/`lambda:*` instead of a narrower list:** Terraform's resources read back many attributes to reconcile state (tags, policy, ACL, versioning, etc.), each requiring its own IAM `Get*` action. A narrower hand-picked list will fail one missing permission at a time as different attributes get read; a broad grant avoids that entirely. This mirrors how every other service in this policy is already granted (`ec2:*`, `ecs:*`, etc.) rather than curated to specific actions — the `Functions` Sid is not a broader grant of trust than the rest of this policy already represents, since the same role can already create/modify the ECS tasks that run your data plane.
>
> **If you already created this role before HTTPS support existed:** add the `Cdn` Sid above to your existing role's policy before your next deploy **or teardown**. Unless you supply your own TLS certificate, Terraform now puts a CloudFront distribution in front of your load balancer so the chatbot is reachable over HTTPS, and without this the deploy fails on `cloudfront:CreateDistribution` with an `AccessDeniedException`. Teardown needs it too, even for a tenant deployed before this change and therefore having no distribution: Terraform reads the managed CloudFront cache policy while resolving the configuration, before it works out that there is nothing to delete.
>
> **If you already created this role before document management existed:** add the `Functions` Sid above to your existing role's policy (IAM → Roles → your `chatbot-client-deploy-*` role → Permissions → edit the policy) before your next deploy — Terraform will fail on `lambda:CreateFunction` with an `AccessDeniedException` otherwise.
>
> **If you already created this role before `iam:ListInstanceProfilesForRole` was added above:** add it to your existing role's `IamForTaskRoles` statement before offboarding — otherwise `terraform destroy` fails partway through with `AccessDenied` on `iam:ListInstanceProfilesForRole` when it tries to delete the tenant's IAM roles (it's a pre-delete check the AWS provider runs automatically; it only surfaces on destroy, never on deploy).

This role's own permissions also implicitly cover reading and writing to the platform's shared Terraform state bucket (the platform operator grants that bucket's cross-account access separately, scoped to your specific AWS account — nothing you need to configure).

### 5. Copy the role's ARN
`arn:aws:iam::<your-account-id>:role/chatbot-client-deploy-<something>`

### 6. Get your LLM API key
| Provider | Where |
|---|---|
| OpenAI | platform.openai.com → API keys |
| Anthropic | console.anthropic.com → API keys |
| OpenRouter | openrouter.ai → Keys |

> **OpenRouter users:** the platform's default model for OpenRouter tenants points at a specific free-tier slug. OpenRouter's free-tier catalog rotates over time and can 404 without warning. We recommend setting an explicit **LLM model override** on the onboarding form rather than relying on the default — check [openrouter.ai/models](https://openrouter.ai/models) for what's currently available, or use OpenRouter's own error message (if you hit a 404) to find the exact working slug it suggests.

### 7. If using Pinecone: get your own Pinecone API key
Sign up (or use your existing account) at [app.pinecone.io](https://app.pinecone.io) → API keys. The platform creates one dedicated serverless index for you inside your own project — you don't need to create the index yourself.

> Every tenant's Pinecone index is created in **AWS us-east-1**, regardless of what AWS region you picked in step 1. If data residency matters for your embeddings specifically, use pgvector instead — see Known Limitation #6 in `SECURITY.md`.

### 7b. (Strongly recommended) Request a TLS certificate
Without this, your chatbot is served over **plain HTTP**: every question, every answer, and every passage retrieved from your documents crosses the internet unencrypted and readable by anything on the network path. Setting it up takes a few minutes and costs nothing.

It requires a domain you control, because AWS Certificate Manager will only issue for a hostname whose DNS you can prove you own — and the load balancer's own `*.elb.amazonaws.com` name is not one of those.

1. Decide the hostname your users will visit, e.g. `chat.acme.com`.
2. AWS Certificate Manager → **in the same region as your deployment** → Request a public certificate for that hostname.
3. Choose **DNS validation** and add the CNAME record ACM gives you to your DNS provider.
4. Wait for the status to reach **Issued**, usually a few minutes.
5. Copy the certificate ARN. It looks like `arn:aws:acm:us-east-1:123456789012:certificate/…`.

Put that ARN, and the same hostname, into the onboarding form. Both fields are needed: a certificate on its own has no hostname to cover.

### 8. Fill out the onboarding form
| Field | Value |
|---|---|
| Cloud provider | AWS |
| Tenant name / Slug | Your choice — slug is 3–32 chars, lowercase + hyphens, can't change later |
| AWS account ID | From step 1 |
| AWS region | From step 1 |
| Deployment role ARN | From step 5 |
| S3 prefix (optional) | Folder path if you want to scope documents |
| Custom domain (optional) | Your own hostname, e.g. `chat.acme.com` |
| TLS certificate ARN (optional) | From step 7b. Required for HTTPS |
| LLM provider / key / model | From steps 6–7 |
| Vector store | Pinecone or pgvector |
| Pinecone API key | Only if you picked Pinecone |

### 9. Submit and wait
The platform assumes your role, writes your LLM key (and Pinecone key, if any) into your own Secrets Manager, then triggers the deployment. Watch progress on the tenant page.

### 10. Access your chatbot
**With a certificate.** The load balancer serves HTTPS on 443 and redirects port 80 to it. After the first deploy, point your hostname at the load balancer with a CNAME to the chatbot URL shown on the tenant page, then visit `https://chat.acme.com`.

**Without one.** A CloudFront distribution is created in front of the load balancer, and your chatbot URL is its hostname:
```
https://d111111abcdef8.cloudfront.net/
```
That is HTTPS for everyone who visits the chatbot, on CloudFront's own certificate, with no DNS work on your part. Allow a few minutes after the deploy reports success before it answers everywhere.

Two things to know about this mode. The hop from CloudFront to your load balancer is plain HTTP inside AWS, because the load balancer has no certificate of its own; supply one if you need TLS the whole way. And the load balancer stays directly reachable over HTTP, so the unencrypted address still works — publish the CloudFront URL, not that one.

---

## Path B — Azure

### 1. Get your subscription ID and tenant ID
- Portal: Subscriptions → copy the Subscription ID.
- Portal: Microsoft Entra ID → Overview → copy the Tenant ID.
- CLI: `az account show --query "{sub:id, tenant:tenantId}"`

### 2. Create a service principal (App Registration)
Microsoft Entra ID → App registrations → New registration → copy the **Application (client) ID**.

### 3. Create a client secret
Certificates & secrets → New client secret → **copy the "Value" column immediately** (shown only once).

### 4. Grant Contributor at the **subscription** level — not a resource group
```
az role assignment create --assignee <app-client-id> --role Contributor --scope /subscriptions/<subscription-id>
```
⚠️ This must be subscription-scoped. Terraform creates your resource group itself during deployment — a role assignment scoped to a resource group that doesn't exist yet cannot be created, and the very first deploy will fail at the resource-group-creation step if you try to narrow this.

### 5. Pick a region
E.g. `eastus`, `westeurope`.

### 6. Get your LLM API key
Same providers/links as the AWS section above (including the OpenRouter caveat).

### 7. If using Pinecone: get your own Pinecone API key
Same as the AWS section — one dedicated index provisioned per tenant, always in AWS `us-east-1` regardless of your Azure region.

### 8. Fill out the onboarding form
| Field | Value |
|---|---|
| Cloud provider | Azure |
| Tenant name / Slug | Slug is 3–18 chars (Azure Key Vault naming limit) |
| Subscription ID / Tenant ID | From step 1 |
| Service principal client ID / secret | From steps 2–3 |
| Azure region | From step 5 |
| LLM provider / key / model | From steps 6–7 |
| Vector store | Pinecone or pgvector |
| Pinecone API key | Only if you picked Pinecone |

### 9. Submit and wait
Your secrets are encrypted and passed to the Azure deploy workflow, which replicates the platform's chatbot images into your ACR, provisions the resource group/ACR/Key Vault/Container App, and writes your keys into Key Vault. Watch progress on the tenant page.

### 10. Access your chatbot
Azure Container Apps automatically provisions a managed HTTPS endpoint on the `*.azurecontainerapps.io` FQDN shown on the tenant page — unlike AWS, HTTPS works out of the box here, no extra configuration needed.

---

## After deployment

- **Managing documents (AWS):** once your first deployment succeeds, a "Documents" section appears on your tenant page — upload, and delete documents for your knowledge base directly from the platform, instead of going to the AWS Console. Uploads go straight from your browser to your S3 bucket; the platform never receives or stores the file contents, and holds no AWS credential capable of reading them — see `ARCHITECTURE.md` for how this is enforced. After an upload or delete, the platform automatically asks your chatbot to reindex — this re-embeds every document under your prefix, not just the changed one, so it can take a moment for larger knowledge bases. **Deleting a document does not remove its already-generated answers from the vector index** — the chatbot's indexing endpoint only adds/updates, it doesn't purge. Azure tenants: this isn't available yet — keep using your Storage account directly.
- **Cost visibility:** both the onboarding form and the tenant page show a live estimated monthly cost breakdown for your specific configuration (see `src/lib/pricing.ts`). For **actual** spend, every resource is tagged `Tenant = <your-slug>` — activate that tag in AWS Cost Explorer or Azure Cost Management to filter your real bill.
- **Redeploying:** use the "Redeploy" button on the tenant page to push a new chatbot version or pick up infrastructure changes — this triggers a fresh deployment run. Re-running a failed GitHub Actions job directly (rather than via the platform's Redeploy button) replays the workflow file as it existed at that run's original commit, which may not include recent fixes.
- **Troubleshooting:** see the Known Limitations section in `SECURITY.md` for documented gaps (Pinecone region, Azure pgvector networking, etc.).
