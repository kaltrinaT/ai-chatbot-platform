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

### 2. Create the deployment identity — one click

Start the onboarding form first (step 9) and fill in your account ID, region and a short name (the slug). The form checks the slug as you type, against every other chatbot and against S3 bucket names anyone already holds, because the setup names your role and your state bucket after it. Once the slug is confirmed free, its Cloud Configuration step shows a **Configure AWS account** button.

> **Keep the same form.** The form generates your chatbot's ID when it opens, and the setup trusts that ID. Save a draft if you need to leave; reopening the draft keeps the ID. A fresh form gets a new ID, and a setup already run does not trust it.

That button opens the AWS console on a CloudFormation stack with every value already filled in. Review what it will create and press **Create stack**. It creates:

- GitHub registered as an OIDC identity provider in your account, if it isn't already
- An IAM role named `chatbot-client-deploy-<your short name>`
- A trust policy with two statements (explained below)
- The permissions Terraform needs to build your chatbot

When it finishes, open the stack's **Outputs** tab and copy `DeploymentRoleArn` back into the form.

> **Already have GitHub registered as an identity provider** — from another chatbot, or from your own use of GitHub Actions? An AWS account can register an issuer only once, and a second attempt fails the whole stack. Tick the box above the button that says so, and the link sets the stack's **Register GitHub as an identity provider?** parameter to **No**, reusing the existing one.

⚠️ **Do this before submitting the form.** Onboarding writes your API keys into your Secrets Manager right away, so the role has to exist first.

### 3. What the two trust statements mean

**Statement 1 — your deployments.** GitHub signs a token for each workflow run describing which repository and environment it ran in. AWS checks that token against the identity provider in *your* account and compares the subject:

```
repo:<owner>/<repo>:environment:tenant-<your chatbot's ID>
```

The environment names your chatbot specifically, so a deployment for anyone else's chatbot carries a different subject and is refused by AWS. The platform is not a party to this exchange at all, and no credential for your account exists anywhere outside the run.

**Statement 2 — onboarding only.** Before any workflow exists, the platform writes your LLM key, vector-database key and document-signing secret directly into your Secrets Manager. That is what keeps those keys out of GitHub Actions entirely — only the resulting ARNs are ever passed to a deployment. The platform makes that one call itself, so your role trusts its AWS account for it, conditioned on an `sts:ExternalId` that is your chatbot's ID.

Without that condition, your role could be used for *any* chatbot the platform is asked to create, including one someone else sets up with your role ARN — which isn't secret. It isn't a password, and it will appear in your CloudTrail logs.

### 4. If you'd rather not use the stack

Create the role by hand: **IAM → Roles → Create role → Custom trust policy**, and paste the trust policy the onboarding form shows (it has a copy button, with your values filled in). You will also need to register GitHub as an identity provider under **IAM → Identity providers**, with audience `sts.amazonaws.com`.

**The role name must start with `chatbot-client-deploy-`** (e.g. `chatbot-client-deploy-acme`). The platform's own AWS identity is restricted by its own IAM policy to only assume roles matching `arn:aws:iam::*:role/chatbot-client-deploy-*` — any other name means onboarding is denied before your trust policy is even evaluated.

Then attach the permissions policy below. This role needs to create everything Terraform provisions on your behalf: a VPC, an Application Load Balancer, an ECS cluster with two Fargate services, two ECR repos, an S3 documents bucket, a per-tenant docs-signer Lambda (for the platform's document upload/delete UI — see `DOCUMENT-MANAGEMENT.md`), a CloudWatch log group, IAM roles for the ECS tasks and the Lambda, Secrets Manager secrets, a CloudFront distribution (unless you bring your own TLS certificate — see step 8), and (if you chose pgvector) an RDS instance.

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

#### Where the deployment state lives

Terraform records everything it creates for this chatbot, including the generated vector-database password, in a state file. That file lives **in your account**, in an S3 bucket the bootstrap stack creates:

```
tfstate-<slug>-<your-account-id>-<region>-an
```

- **Only your account can own that name.** The `-an` suffix places it in your account-regional namespace, so no other AWS account can register it first.
- **It is versioned, private and TLS-only.** Superseded versions expire after 30 days.
- **It survives deletion of the stack.** Deleting the stack revokes the platform's access and would otherwise fail on a bucket that still holds state. Delete the bucket yourself once the chatbot's infrastructure is gone.

If you create the role by hand instead of with the stack, create this bucket too. The platform's setup panel shows the commands. The role's `s3:*` grant already covers it, so there is nothing to add to the policy.

**Bootstrapped before the stack created this bucket?** Update the existing stack to the current template once. The tenant page shows the exact `aws cloudformation update-stack` command, which keeps every value the stack was created with. Deployments refuse to run until the bucket exists, and **Test connection** confirms it does.

### 5. Copy the role's ARN and test the connection
`arn:aws:iam::<your-account-id>:role/chatbot-client-deploy-<something>` — from the stack's Outputs tab, or from the role itself if you created it by hand.

Paste it into the form. The form refuses a role ARN another chatbot already uses: each chatbot's setup creates its own role, trusting that chatbot only, so someone else's is always a leftover, typically offered by the browser's form history.

Then press **Test connection**. That runs a check which signs in to your account exactly as a deployment would, confirms the state bucket exists, and does nothing else: no resources, no changes, a few seconds, repeatable as often as you like. If it says **Connected**, your setup is correct. If it fails, it says why when the cause is known, such as a missing identity provider or a role that does not trust this chatbot, and otherwise names the step that failed. That is almost always a subject mismatch, a missing identity provider, or a stack that predates the state bucket, and far easier to fix now than thirty minutes into a deployment.

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

### 8. (Optional) Request a TLS certificate for your own domain

**You do not need this to get HTTPS.** If you skip it, the platform puts a CloudFront distribution in front of your load balancer and your chatbot is served over HTTPS on a `*.cloudfront.net` address, with no DNS work from you.

Supply a certificate when you want either of:

- **Your own hostname** — `https://chat.acme.com` rather than a CloudFront address.
- **Encryption the whole way** — with CloudFront, the hop from CloudFront to your load balancer is plain HTTP inside AWS, and the load balancer also stays reachable over plain HTTP. Terminating TLS on the load balancer itself removes both.

It requires a domain you control, because AWS Certificate Manager only issues for a hostname whose DNS you can prove you own, and the load balancer's own `*.elb.amazonaws.com` name is not one of those.

1. Decide the hostname your users will visit, e.g. `chat.acme.com`.
2. AWS Certificate Manager → **in the same region as your deployment** → Request a public certificate for that hostname.
3. Choose **DNS validation** and add the CNAME record ACM gives you to your DNS provider.
4. Wait for the status to reach **Issued**, usually a few minutes.
5. Copy the certificate ARN. It looks like `arn:aws:acm:us-east-1:123456789012:certificate/…`.

Put that ARN, and the same hostname, into the onboarding form. Both are needed: a certificate on its own has no hostname to cover.

### 9. Fill out the onboarding form
| Field | Value |
|---|---|
| Cloud provider | AWS |
| Tenant name / Slug | Your choice — slug is 3–21 chars, lowercase + hyphens, can't change later, and can never be reused, even after the chatbot is deleted |
| AWS account ID | From step 1 |
| AWS region | From step 1 |
| Deployment role ARN | From step 5 |
| S3 prefix (optional) | Folder path if you want to scope documents |
| Custom domain (optional) | Your own hostname, e.g. `chat.acme.com` |
| TLS certificate ARN (optional) | From step 8. Leave blank to be served over CloudFront instead |
| LLM provider / key / model | From steps 6–7 |
| Vector store | Pinecone or pgvector |
| Pinecone API key | Only if you picked Pinecone |

### 10. Submit and wait
The platform assumes your role, writes your LLM key (and Pinecone key, if any) into your own Secrets Manager, then triggers the deployment. Watch progress on the tenant page.

### 11. Access your chatbot

The tenant page shows the URL to use. Either way your visitors get HTTPS; what differs is where TLS ends and what else stays reachable.

| | Certificate supplied (step 8) | No certificate |
|---|---|---|
| Your chatbot URL | `https://chat.acme.com` | `https://d111111abcdef8.cloudfront.net/` |
| TLS terminates at | Your load balancer | CloudFront |
| Encrypted end to end | Yes | No — the CloudFront to load balancer hop is plain HTTP inside AWS |
| Plaintext address still serving | No — port 80 redirects to 443 | Yes — the load balancer answers on port 80, so publish the CloudFront URL and not that one |
| DNS work needed | Point your hostname at the load balancer with a CNAME to the address on the tenant page | None |

A newly created CloudFront address can take a few minutes after the deploy reports success before it answers everywhere.

---

## Path B — Azure

### 1. Get your subscription ID and tenant ID
- Portal: Subscriptions → copy the Subscription ID.
- Portal: Microsoft Entra ID → Overview → copy the Tenant ID.
- CLI: `az account show --query "{sub:id, tenant:tenantId}"`

### 2. Create the deployment identity — one click

Start the onboarding form first (step 8) and fill in your subscription ID, tenant ID, region and a short name (the slug). The slug names your resource group, deployment identity and state storage, and several Azure names built from it must be unique worldwide. So the form checks it as you type: against every other chatbot, including names that only collide once Azure drops the hyphens and shortens them, and against names Azure already has in use anywhere. Once the slug is confirmed free, its Cloud Configuration step shows a **Configure Azure** button.

> **Keep the same form.** The form generates your chatbot's ID when it opens, and the setup's federated credential trusts that ID. Save a draft if you need to leave; reopening the draft keeps the ID. A fresh form gets a new ID, and a setup already run does not trust it.

That button opens the Azure portal on a template that creates everything at once:

- A resource group named `chatbot-<your short name>`, which is where your chatbot will live
- A **user-assigned managed identity** inside it — no client secret, and no Entra ID permissions needed to create one
- A **federated credential** on that identity, trusting GitHub for this chatbot's deployments only
- **Contributor** and **User Access Administrator**, scoped to that resource group and nothing else
- A **storage account** `cbtf<your short name>` in that group, which keeps your chatbot's Terraform state (see below)

The portal cannot take values from a link, so the form lists the parameters to enter, under the labels the portal shows, with copy buttons next to each:

| Portal field | Value |
|---|---|
| Chatbot Id | This chatbot's ID, shown in the form. **Not** your Azure (Entra) tenant ID, which the portal also displays nearby |
| Chatbot Slug | Your slug, exactly as entered |
| Git Hub Owner / Git Hub Repo | The repository the platform's deployments run from |
| Location | Your chosen region |

Pick the right subscription at the top of the portal form. Alternatively, the form shows an `az deployment sub create` command with every value filled in, including `--subscription`, so it cannot land in whichever subscription your Azure CLI defaults to.

When the deployment finishes, open its **Outputs** and copy `clientId` back into the form. The outputs also show your subscription ID and Azure tenant ID.

#### Where the deployment state lives

Terraform records everything it creates for this chatbot in a state file, including your LLM key, your Pinecone key and the generated vector-database password. That file lives **in your subscription**, in the storage account above (container `tfstate`):

- **It accepts no account key.** Only Microsoft Entra ID sign-in works.
- **Deployments reach it as the deployment identity**, with the same GitHub token that signs them in. That identity holds a data role on the state container only, and none on your documents.
- **It is versioned.** Superseded versions expire after 30 days.
- **It goes with the resource group.** Deleting the group removes it, along with everything else.

**Set up before the template created this storage?** Run the template again, from the same button or with the `az deployment sub create` command the tenant page shows. It adds what is missing and leaves everything else as it is. Deployments refuse to run until the storage exists, and **Test connection** confirms it is ready. If your deployment identity is not the one the template created (for example, an app registration you set up by hand), also run the role-assignment command the tenant page shows, so that identity can read the state.

**Do not create a client secret.** The platform never asks for one.

### 3. What the federated credential means

| Field | Value |
|---|---|
| Issuer | `https://token.actions.githubusercontent.com` |
| Subject | `repo:<owner>/<repo>:environment:tenant-<chatbot ID shown in the form>` |
| Audience | `api://AzureADTokenExchange` |

GitHub signs a token for each workflow run describing which repository and environment it ran in. Entra ID compares that subject — exactly, and case-sensitively — against the credential. The environment names this one chatbot, so a deployment for anyone else's chatbot is refused before any token is issued.

To revoke the platform's deployment access at any time, delete the federated credential; the running chatbot stays up. To revoke everything and remove the chatbot, delete the resource group.

### 4. Why those two roles, and why that scope

**Scoped to the resource group, not the subscription.** The template creates the group before the identity, which is what makes the narrow scope possible — a role assignment cannot target a group that does not exist. Terraform then deploys *into* that group rather than creating it. The identity cannot see or touch anything else in your subscription.

**Why the second role.** Contributor deliberately excludes `Microsoft.Authorization/*/Write`, so it cannot create custom role definitions or assign roles. Your deployment creates two narrow custom roles — one letting the chatbot container read documents and nothing else, one letting the document-upload function write and delete but never read — and grants the chatbot's identity pull access to its image registry. Those grants are how no component ends up holding your storage account key or a registry password. Without User Access Administrator the deploy fails on `Microsoft.Authorization/roleDefinitions/write` or `roleAssignments/write` with an `AuthorizationFailed` error.

Confined to the one resource group, User Access Administrator can grant roles over your chatbot's own resources and nothing else.

### 5. If you'd rather not use the template, and testing the connection

By hand: create an app registration or managed identity, add the federated credential above (portal: the identity → **Federated credentials** → Add), create a resource group named exactly `chatbot-<your short name>`, and grant the identity Contributor and User Access Administrator on it. Then create the state storage and grant the identity its data role. The onboarding form shows ready-made `az` commands for the state storage.

Either way, paste the client ID into the form. The form refuses a client ID another chatbot already uses: each chatbot's setup creates its own identity, trusting that chatbot only, so someone else's is always a leftover, typically offered by the browser's form history.

Then press **Test connection**. It exchanges a token exactly as a deployment would, checks the resource group exists, and checks the identity can read its state storage. It is read-only, takes a few seconds, and can be repeated. It distinguishes the failures that look identical from the outside: federation that doesn't work at all, federation that works into a subscription where the setup never ran, and setup that predates the state storage. When Azure refuses the sign-in for a known reason, it says what to do: for example, a credential whose subject names another chatbot ID (`AADSTS700213`), an identity with no federated credential at all (`AADSTS70025`), or a client ID or tenant ID that does not exist (`AADSTS700016`, `AADSTS90002`).

### 6. Get your LLM API key
Same providers/links as the AWS section above (including the OpenRouter caveat).

### 7. If using Pinecone: get your own Pinecone API key
Same as the AWS section — one dedicated index provisioned per tenant, always in AWS `us-east-1` regardless of your Azure region.

### 8. Fill out the onboarding form
| Field | Value |
|---|---|
| Cloud provider | Azure |
| Tenant name / Slug | Slug is 3–18 chars (Azure Key Vault naming limit), can't change later, and can never be reused |
| Subscription ID / Tenant ID | From step 1 |
| Deployment identity client ID | From step 2 (the bootstrap creates it, and the credential, together) |
| Azure region | From step 2 |
| LLM provider / key / model | From steps 6–7 |
| Vector store | Pinecone or pgvector |
| Pinecone API key | Only if you picked Pinecone |

### 9. Submit and wait
The Azure deploy workflow signs in to your subscription through the federated credential — if it is missing or its subject differs, the deploy stops at sign-in, before creating anything, and the tenant page shows the subject it expected. Your LLM and Pinecone keys are stored encrypted by the platform and released once to that deployment's own run, which proves which chatbot it is for with its GitHub token. The run replicates the platform's chatbot images into your ACR, provisions the ACR, Key Vault and Container App in your resource group, writes your keys into Key Vault, and keeps its Terraform state in your state storage. Watch progress on the tenant page.

### 10. Access your chatbot
Azure Container Apps automatically provisions a managed HTTPS endpoint on the `*.azurecontainerapps.io` FQDN shown on the tenant page — unlike AWS, HTTPS works out of the box here, no extra configuration needed.

---

## After deployment

- **Managing documents:** once your first deployment succeeds, a "Documents" section appears on your tenant page on both clouds. Upload and delete documents for your knowledge base directly from the platform, instead of going to the AWS Console or Azure portal. Uploads go straight from your browser to your S3 bucket or Blob container; the platform never receives or stores the file contents, and holds no credential capable of reading them — see `DOCUMENT-MANAGEMENT.md` for how this is enforced. Your storage accepts uploads only from the platform's own address, so upload from there. After an upload or delete, the platform automatically asks your chatbot to reindex. This re-embeds every document under your prefix, not just the changed one, so it can take a moment for larger knowledge bases. The same reindex removes a deleted document's vectors, so the chatbot stops answering from it once reindexing finishes.
- **Cost visibility:** both the onboarding form and the tenant page show a live estimated monthly cost breakdown for your specific configuration (see `src/lib/pricing.ts`). For **actual** spend, every resource is tagged `Tenant = <your-slug>` — activate that tag in AWS Cost Explorer or Azure Cost Management to filter your real bill.
- **Redeploying:** use the "Redeploy" button on the tenant page to push a new chatbot version or pick up infrastructure changes — this triggers a fresh deployment run. Re-running a failed GitHub Actions job directly (rather than via the platform's Redeploy button) replays the workflow file as it existed at that run's original commit, which may not include recent fixes.
- **Troubleshooting:** see the Known Limitations section in `SECURITY.md` for documented gaps (Pinecone region, Azure pgvector networking, etc.).
