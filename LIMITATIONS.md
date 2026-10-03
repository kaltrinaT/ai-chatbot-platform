# Architectural Limitations

This document lists the known limitations of the platform's architecture: what the design cannot do, where it is weaker than it looks, and why. It describes the code as of 30 September 2026.

Security limitations have their own list in [`SECURITY.md`](SECURITY.md#known-limitations), numbered #1–#13. This document cites them as "`SECURITY.md` #n" where an architectural choice is the cause, and does not repeat them.

Each limitation has one disposition:

| Disposition | Meaning |
|---|---|
| **By design** | A direct consequence of a property the platform is built to have. Removing the limitation would remove the property. |
| **External** | Imposed by a service the platform depends on (GitHub, AWS, Azure). The design works around it. |
| **Scope** | Outside what the prototype set out to do. A production system would need it. |
| **Deferred** | A fix is known and not yet built. |

---

## Summary

| # | Limitation | Area | Disposition |
|---|---|---|---|
| 1 | Every tenant pays for a complete, always-on stack | Isolation model | By design |
| 2 | The platform cannot see whether a chatbot works | Isolation model | By design |
| 3 | The customer's cloud can change without the platform knowing | Isolation model | By design |
| 4 | Changing the customer-side footprint needs every customer to act | Isolation model | By design |
| 5 | Query-time data still leaves the customer's cloud | Isolation model | Scope / Deferred |
| 6 | The platform still calls into the data plane | Isolation model | By design / Deferred |
| 7 | The control plane has no production deployment | Control plane | Scope |
| 8 | Nothing runs in the background | Control plane | Deferred |
| 9 | One user owns each tenant | Control plane | Scope |
| 10 | One static encryption key | Control plane | Deferred |
| 11 | The document list exists only in the platform's database | Control plane | By design |
| 12 | A tenant can barely be changed after it is created | Control plane | Deferred |
| 13 | No fleet operations and no pinned versions | Control plane | Deferred |
| 14 | The platform keeps little history of its own runs | Control plane | Deferred |
| 15 | Each cloud is a separate vertical slice | Control plane | Scope |
| 16 | GitHub is orchestrator, token issuer and trust anchor | Orchestration | By design |
| 17 | Dispatch is asynchronous and returns nothing | Orchestration | External |
| 18 | Credential lifetimes cap how long a run may take | Orchestration | External |
| 19 | Fleet throughput is bounded by GitHub | Orchestration | External |
| 20 | Azure deploys need the control plane to be up | Orchestration | By design |
| 21 | Workflow actions and images are referenced by mutable tags | Orchestration | Deferred |
| 22 | Every tenant runs single-instance, in one region | Tenant runtime | Scope |
| 23 | Chat and indexing share one CPU process | Tenant runtime | Deferred |
| 24 | The embedding model is fixed and downloaded at start-up | Tenant runtime | Deferred |
| 25 | Network exposure is set by cost, not by least exposure | Tenant runtime | Deferred |
| 26 | Resource names derived from the slug are checked, not reserved | Tenant runtime | Deferred |
| 27 | The AWS and Azure paths are not equivalent | Tenant runtime | Deferred / By design |
| 28 | The chatbot backend lives outside this repository | Scope boundary | Scope |

---

## 1. Consequences of the isolation model

The platform's central property is that each chatbot runs in its customer's own cloud account and the platform stays out of the data path (see [`ARCHITECTURE.md`](ARCHITECTURE.md#control-plane--data-plane-boundary)). The limitations in this section follow from that property. They are its price, not defects in how it was built.

### 1. Every tenant pays for a complete, always-on stack

Nothing is shared between tenants. Each deploy creates, in the customer's account and through a full `terraform apply`, its own network, load balancer or ingress, container runtime, registry, secret store, document storage, signer function and vector store.

- **Every tenant has a fixed monthly cost.** The platform's estimator ([`src/lib/pricing.ts`](src/lib/pricing.ts)) puts an idle Pinecone tenant at about $66–77 a month on AWS and $66–75 on Azure, before LLM and Pinecone usage. pgvector adds about $14 on AWS and $17 on Azure. Nearly all of it is always-on compute and, on AWS, the load balancer, so it is paid whether or not anyone uses the chatbot.
- **Cost grows linearly with the number of tenants.** A pooled design would share the fixed part. This one cannot without placing two customers in one account.
- **Every deploy is a full infrastructure build.** The deploy jobs allow 45 minutes. Actual durations have not been measured yet (`EVALUATION.md` EA2).

**Disposition: By design.** This is the isolation premium discussed in `EVALUATION.md` §6. It makes the model a poor fit for small, low-traffic customers.

### 2. The platform cannot see whether a chatbot works

The control plane knows how a deployment *ended*, not how the chatbot is *doing*. After the workflow reports success, the platform receives nothing more: no health status, no error rates, no usage and no spend. It never calls the chatbot's `/api/health` itself.

- A chatbot that crashes, loses its LLM key or exhausts its provider quota still shows as deployed.
- "Deployed" means Terraform finished (`T5` in `EVALUATION.md` §4), not that the chatbot answers questions (`T7`).
- The cost shown at onboarding is a static list-price estimate. The platform never sees the actual bill.
- Monitoring is the customer's job, in their own CloudWatch or Log Analytics.

**Disposition: By design.** Collecting runtime signals would mean reading logs or traffic, which the boundary forbids. A narrow middle ground exists and is not built: probing the public `/api/health` endpoint, which reveals nothing about the customer's data.

### 3. The customer's cloud can change without the platform knowing

The customer owns every resource, including the Terraform state that describes them. They can edit, delete or re-permission any of it. The platform finds out only when its next run fails or plans unexpected changes. There is no drift detection.

The Terraform state itself lives in the customer's account (`tfstate-<slug>-<account>-<region>-an` on AWS, `cbtf<slug>` on Azure). If the customer deletes it, the platform can no longer update or remove that chatbot: the next run stops rather than start again from empty state.

The cloud provider's own defaults can change the same way. The Azure Container Apps environment was once declared without a mode, and on 29 September 2026 Azure created one as **Express**, a tier that refuses sidecar containers, health probes and revision suffixes, so the chatbot's app could not be created in it. The mode is now stated explicitly ([`infra/terraform/azure/main.tf`](infra/terraform/azure/main.tf)), but any other setting left to a provider default can shift the same way, and the platform learns of it only when a deploy fails.

**Disposition: By design.** Customer control over their own account is the point. The platform can report only what it observes, and **Test connection** checks the sign-in at one moment without storing the result. Provider defaults are narrowed by stating every setting the chatbot depends on.

### 4. Changing the customer-side footprint needs every customer to act

The platform holds no credential for any customer cloud. So anything outside a normal deploy can be changed only by the customer re-running their bootstrap: the trust policy, the OIDC provider, the deployment role's permissions, and the state bucket or storage account. Each recent change of this kind required every existing tenant to re-run its bootstrap before its next deploy would work. That applied to both federated sign-in and moving Terraform state into customer accounts.

Teardown has the same shape. It removes the chatbot, not what the customer created. On AWS the bootstrap stack, its role and the state bucket remain. On Azure the resource group, the deployment identity and the state storage account remain. The customer deletes those themselves.

**Disposition: By design.** The effort of each platform upgrade grows with the number of customers, and each upgrade waits on them.

### 5. Query-time data still leaves the customer's cloud

Documents stay in the customer's account, and so do embeddings when the tenant uses pgvector. Three flows do not:

| Flow | Where it goes | Why |
|---|---|---|
| Every question, with the document passages retrieved for it | The LLM provider: OpenAI, Anthropic or OpenRouter | All three supported providers are external APIs. There is no in-cloud option such as Amazon Bedrock or Azure OpenAI, and no custom endpoint: Terraform derives the base URL from the provider name, and the `llm_base_url` column is never read |
| Embeddings, when the tenant uses Pinecone | Pinecone, always in AWS `us-east-1` | `SECURITY.md` #6 |
| Document file names and sizes | The platform's database | The document list is drawn from it (#11) |

So "documents never leave the customer's cloud" holds for documents at rest. It does not hold for the passages the chatbot sends to its model on every question. A customer with a strict residency requirement needs both pgvector and an LLM endpoint inside their own cloud. The platform cannot offer the second.

**Disposition:** Scope for the LLM endpoint. Deferred for the Pinecone region. By design for file names.

### 6. The platform still calls into the data plane

Two paths cross the boundary from the control plane:

- **Document operations** go through the docs-signer function in the tenant's account. The platform authenticates with a shared secret it can decrypt at any time (`SECURITY.md` #2). Through it the platform can write and delete a tenant's documents, but never read them.
- **Indexing** starts with the platform calling the chatbot's public `POST /api/index` after every upload and delete. When CloudFront fronts the tenant, this call goes straight to the load balancer over plain HTTP, because CloudFront's 60-second origin limit is shorter than a reindex may take ([`src/lib/reindex.ts`](src/lib/reindex.ts)). The call carries no credential and no document content.

**Disposition:** By design for document management, a deliberate and narrow exception. Deferred for indexing: if storage events inside the customer's cloud started indexing, this call would disappear (`SECURITY.md` #10).

---

## 2. Control plane

### 7. The control plane has no production deployment

The operator uses the Next.js control plane from their own machine. A second copy of the same application runs on Vercel and shares its database and encryption key. That copy is what `PLATFORM_BASE_URL` names, and so what GitHub runners reach for status callbacks and, on Azure, for secrets (#20). Neither copy is a managed production deployment: nothing keeps their code in step, and there is no failover between them.

- Onboarding reaches AWS through the operator's own `aws login` session, so a person must be signed in. The code already supports a host with its own workload identity (`PLATFORM_AWS_ROLE_ARN` in [`src/lib/aws.ts`](src/lib/aws.ts), trusted through [`infra/platform/control-plane`](infra/platform/control-plane/main.tf)); the prototype does not onboard from the hosted copy.
- A tenant's document storage accepts browser uploads only from `PLATFORM_BASE_URL` and one optional extra origin, `EXTRA_CORS_ORIGIN`. Uploading from the local copy therefore needs `EXTRA_CORS_ORIGIN=http://localhost:3000`, and a tenant picks up a change to either value only when it is redeployed.
- When the control plane is down, **running chatbots are unaffected**, since they depend on nothing in it. Onboarding, document management and Azure deploys stop. AWS deploys still finish, but their outcome is not recorded until reconciled (#8).

**Disposition: Scope.**

### 8. Nothing runs in the background

There is no job queue and no scheduler. Every operation runs inside a web request or server action. Three things follow.

- **Lost status callbacks are repaired only on demand.** Reconciliation from GitHub runs when someone opens the tenant page, or when an operator runs [`scripts/reconcile-deployment.ts`](scripts/reconcile-deployment.ts). Until then a deployment can show `running` long after its run ended. A tenant can have only one active deployment, so this blocks its next deploy or teardown. After 75 minutes, opening the page marks a run it cannot find as failed.
- **Indexing is synchronous.** The platform waits up to 120 seconds for `/api/index`. A larger corpus takes longer, and the operator sees a failure for a reindex that is still running and will succeed.
- **Onboarding cannot undo a partial failure.** On AWS it writes secrets into the customer's Secrets Manager, then inserts the tenant row, then dispatches the workflow. A failure after the first step leaves secrets in the customer's account with no tenant pointing at them. A failure at dispatch leaves a tenant with one failed deployment, which a redeploy recovers.

**Disposition: Deferred.** A scheduled reconciler and asynchronous indexing would remove the first two. The third needs an explicit onboarding state with a cleanup step.

### 9. One user owns each tenant

Every tenant belongs to the GitHub account that created it (`tenants.owner_user_id`), and every query filters on it. There are no organisations, teams, roles or delegated access, and no way to transfer a tenant. The list of accounts allowed to sign in at all is an environment variable (`AUTH_ALLOWED_EMAILS`, `SECURITY.md` #7).

**Disposition: Scope.** The prototype's operator is its only user.

### 10. One static encryption key

Every stored secret is encrypted with a single AES-256-GCM key taken from `PLATFORM_ENCRYPTION_KEY` ([`src/lib/crypto.ts`](src/lib/crypto.ts)).

- The ciphertext records no key version, and the code can hold only one key at a time. Rotating the key therefore means re-encrypting every row in a single step.
- The key sits in the process environment, not in a KMS or HSM. Whoever can read the environment can decrypt everything.
- There are no per-tenant keys, so deleting a tenant cannot make its secrets unreadable in older backups (crypto-shredding, discussed in `SECURITY.md`).

**Disposition: Deferred.** Envelope encryption under a cloud KMS, with a key ID stored beside each ciphertext, would address all three.

### 11. The document list exists only in the platform's database

The platform never lists a tenant's storage, and holds no credential that could. The document list in the UI is the `tenant_documents` table, not the bucket or container.

- A file added or removed directly in storage is invisible to the platform, yet the chatbot indexes what is really there. The UI and the chatbot can therefore disagree about the knowledge base.
- An upload the browser starts, then neither confirms nor abandons, stays `pending`.
- Nothing reconciles the two.

**Disposition: By design.** Listing storage would require the read access the boundary rules out.

### 12. A tenant can barely be changed after it is created

After onboarding, the UI offers four things: redeploy, delete, test the connection, and manage documents. None of the following can be changed from the UI:

- the LLM key, provider or model
- the domain or certificate
- the chatbot version
- an Azure tenant's client ID

Two operator scripts cover part of this. [`scripts/update-azure-tenant-identity.ts`](scripts/update-azure-tenant-identity.ts) changes the client ID. [`scripts/update-tenant-llm.ts`](scripts/update-tenant-llm.ts) changes the LLM settings, but on AWS it replaces only the platform's encrypted copy of the key. An AWS chatbot reads its key from the customer's Secrets Manager, which only onboarding writes, so a key rotated this way never reaches it.

The cloud, region, vector store and slug are fixed for the tenant's lifetime. Changing any of them means creating a new tenant and moving the documents by hand. A slug can never be reused, even after deletion, because the soft-deleted row keeps it.

**Disposition: Deferred.** The platform was built around create, deploy and delete. Editing a tenant needs a validated update path, and on AWS a second, onboarding-style write into the customer's Secrets Manager.

### 13. No fleet operations and no pinned versions

Images are referenced by a mutable tag (`latest` by default) and copied into each tenant's registry on every deploy. The platform records the tag, not the image digest.

- Two tenants on `latest` that were deployed at different times run different code, and the platform cannot say which.
- A new chatbot version reaches a tenant only when that tenant is redeployed. There is no bulk upgrade, staged rollout or canary. A backend security fix therefore protects nobody until each tenant is redeployed, one at a time (as with `SECURITY.md` #10).
- Rolling one tenant back means pointing the shared tag at the old image. Every tenant redeployed after that gets the old image too.

**Disposition: Deferred.** [`infra/terraform/main.tf`](infra/terraform/main.tf) already names tagging by digest or commit as the better design.

### 14. The platform keeps little history of its own runs

A deployment row records when the run started and finished and how it ended. Step timings, logs and Terraform plans exist only in GitHub, for as long as GitHub retains them. The outputs artifact is kept for 90 days. The platform cannot later show where a run spent its time, which `EVALUATION.md` §9 identifies as a blocker for measuring deployments.

**Disposition: Deferred.** `EVALUATION.md` §9 describes the fix: archive step timings when a run finishes.

### 15. Each cloud is a separate vertical slice

Supporting a cloud takes its own set of parts:

- columns on the `tenants` table
- deploy, destroy and verify workflows
- a Terraform root
- a bootstrap template
- a docs-signer implementation
- a branch in the onboarding wizard

The two Terraform roots describe the same architecture in each provider's terms, and are kept in step by hand. That is how the differences in #27 arose. Adding a third cloud would touch every layer.

**Disposition: Scope.** Two clouds were enough to test portability. The next step would be a provider-neutral tenant model and a shared interface for the Terraform modules.

---

## 3. Orchestration through GitHub Actions

### 16. GitHub is orchestrator, token issuer and trust anchor

Every deploy, teardown and connection check is a GitHub Actions run. On both clouds, the customer's trust rests on the OIDC token GitHub signs for that run.

- A GitHub outage stops every deploy and teardown on both clouds.
- The per-tenant binding depends on GitHub environments, which a private repository gets only on a paid plan. Without one, nothing deploys. It fails closed. The prototype's repository is public for this reason, which also makes its workflows and run logs public.
- Whoever controls the repository's workflows can act in every customer account that trusts it (`SECURITY.md` #8).

**Disposition: By design.** This is what lets the platform hold no cloud credential. The trust did not disappear; it moved to GitHub and the repository.

### 17. Dispatch is asynchronous and returns nothing

`workflow_dispatch` accepts a request and returns no run ID. The platform matches a run to its deployment in two ways: the deployment ID in the run's name, and an early callback from the run itself. It learns the outcome from a later callback. One shared webhook secret authenticates callbacks from every tenant's runs. The Azure workflow packs its settings into a single JSON input because GitHub limits how many inputs a dispatch may carry.

**Disposition: External.** These are properties of the GitHub API that the platform works around.

### 18. Credential lifetimes cap how long a run may take

An AWS role session lasts at most one hour. An `az` login cannot refresh, so it lasts only as long as Entra's first token, 60–90 minutes. The deploy jobs therefore time out at 45 minutes and the AWS teardown at 60. A deploy that needs longer, for example because a database or CloudFront distribution is slow to create, fails rather than extends. The timeouts cannot be raised unless credentials are also refreshed mid-run.

**Disposition: External.**

### 19. Fleet throughput is bounded by GitHub

Each deploy is one job on a GitHub-hosted runner. The number that can run at once is capped by the account's concurrent-job limit. Live progress and reconciliation call the GitHub REST API with one personal access token, so they share its rate limit, and every open tenant page polls it. Neither limit has been tested against a large fleet.

**Disposition: External.**

### 20. Azure deploys need the control plane to be up

An Azure run fetches the tenant's LLM key, Pinecone key and docs-signer secret from the platform while it runs (`POST /api/deployments/{id}/secrets`). It has to, because the customer's Key Vault does not exist until that same run creates it. The platform releases the secrets once per deployment. As a result:

- an Azure deploy fails if the control plane is unreachable. An AWS deploy does not, because its secrets were written into the customer's account at onboarding.
- GitHub's **Re-run jobs** on a failed Azure deploy is refused, and the operator redeploys from the platform instead.

**Disposition: By design.** It follows from Azure having no secret store before the first deploy, and it keeps the secrets out of the workflow's inputs.

### 21. Workflow actions and images are referenced by mutable tags

The third-party actions that handle each run's tokens are pinned to major-version tags, not commit SHAs: `aws-actions/configure-aws-credentials@v4`, `azure/login@v2`, `Azure/functions-action@v1` and `hashicorp/setup-terraform@v3`. A compromised tag would run inside every deploy. The chatbot images are unsigned and copied by tag (#13), so nothing proves a tenant runs the image the platform built.

**Disposition: Deferred.** `SECURITY.md` #8 recommends pinning actions to SHAs. Image signing and pinning by digest would close the rest.

---

## 4. Tenant runtime

### 22. Every tenant runs single-instance, in one region

| | AWS | Azure |
|---|---|---|
| Chatbot backend | 1 task, no autoscaling | 1–3 replicas, scaled together with the chat UI |
| Chat UI | 1 task | Same replicas as the backend |
| pgvector database | RDS `db.t4g.micro`, single-AZ | Flexible Server `B1ms`, no high availability |
| Region | One | One |

On AWS, when the one backend task fails, the chatbot is down until ECS replaces it. Neither cloud keeps a copy in another region or can fail over. Backups exist: 1 day for the RDS database (the most an AWS Free plan account accepts), 7 days for the Azure one, and 30 days of document versions (AWS) or soft-deleted documents (Azure). Restoring from them is manual.

**Disposition: Scope.** These are the cheapest sizes that work, which is why the fixed cost in #1 is as low as it is.

### 23. Chat and indexing share one CPU process

The chatbot backend runs a single Uvicorn worker. Each worker loads its own copy of PyTorch and the embedding model, and two did not fit in the Azure container's 1 GiB. Embedding runs on CPU. Indexing runs in the same process that answers questions, so a reindex competes with live chat traffic.

Every upload or delete triggers a **full** resync: the backend re-reads and re-embeds every document, not just the one that changed. Indexing cost therefore grows with the size of the corpus rather than the size of the change, and a large enough corpus will exceed the platform's 120-second wait (#8).

**Disposition: Deferred.** The fix belongs in the backend repository: incremental, asynchronous indexing in a separate worker.

### 24. The embedding model is fixed and downloaded at start-up

The backend uses `all-MiniLM-L6-v2` and downloads it from Hugging Face the first time it is needed. The image does not include it. Every new task or replica therefore needs internet access to Hugging Face, and its first request waits for the download.

The model's 384-dimension output is fixed in the backend and in Terraform, as the Pinecone index dimension and `PGVECTOR_DIMENSION`. Changing the model therefore means a new index and a full reindex for every tenant.

**Disposition: Deferred.** Building the model into the image removes the download. Changing models remains a migration.

### 25. Network exposure is set by cost, not by least exposure

- **AWS:** tasks run in public subnets with public IPs, to avoid NAT gateway costs, and their security group admits only the load balancer. The pgvector database is the exception: it sits in private subnets with no route to the internet, which costs nothing because it never calls out. The load balancer stays reachable on plain HTTP port 80 even when CloudFront fronts it, and CloudFront reaches it over HTTP. Every tenant's VPC uses the same `10.20.0.0/16`, so it cannot be peered with another tenant's VPC, or with a customer network that uses that range.
- **Azure:** the Container Apps environment has no VNet integration, so the pgvector server is reachable from any Azure-hosted client (`SECURITY.md` #5).
- **Both:** the chat and index endpoints are public, with no WAF and no rate limit (`SECURITY.md` #10 and #13).

**Disposition: Deferred.** Private subnets behind a NAT gateway or VPC endpoints, and VNet integration on Azure, add cost to every tenant and raise the fixed cost in #1.

### 26. Resource names derived from the slug are checked, not reserved

Every resource name is derived from the tenant's slug, and several must be globally unique within their cloud: the S3 bucket `chatbot-<slug>-docs`, and on Azure the storage accounts, the registry, the Key Vault, the Function App host name and the Postgres server. On Azure, storage account and registry names also drop hyphens, and storage account names are cut to 24 characters ([`infra/terraform/azure/main.tf`](infra/terraform/azure/main.tf)), so two valid, distinct slugs can produce the same name: `acme-bot` and `acmebot`, or two long slugs that differ only in their last characters.

Onboarding now checks for both kinds of collision, as the slug is typed and again on the server before anything reaches the customer's cloud ([`src/lib/resourceNames.ts`](src/lib/resourceNames.ts), [`src/lib/nameAvailability.ts`](src/lib/nameAvailability.ts)):

- **Between the platform's own tenants:** every derived Azure name is compared with those of live Azure tenants, using expressions the tests hold to Terraform's own.
- **With names held outside the platform:** the platform asks DNS whether each Azure name exists, and S3 whether the bucket does, with no credential.

The check narrows the problem without closing it:

- **Only a definite answer counts.** A timeout or an unexpected error reads as free, so a flaky resolver never blocks a good slug, and Terraform remains the authority.
- **Nothing is reserved.** A name free at onboarding can be taken before the first `terraform apply`, which then fails as before.
- **The setup's own state storage is not checked**, because the customer's setup creates it before the chatbot is submitted and every Azure onboarding would otherwise be refused.

The slug length limits, 3–21 characters on AWS and 3–18 on Azure, come from the same derived names.

**Disposition: Deferred.** A random suffix on the global names would remove the remaining race, at the cost of names the platform can no longer derive from the slug alone.

### 27. The AWS and Azure paths are not equivalent

`EVALUATION.md` EA5 treats the choice of cloud as an infrastructure decision that should not change the chatbot's behaviour. It does change what the operator and the customer get:

| | AWS | Azure |
|---|---|---|
| Rollout safety configured | ECS circuit breaker with rollback, plus a wait for steady state | Container health probes only |
| Custom domain | Works when a certificate is supplied | Accepted and reported as the chatbot's URL, but never bound, so that URL does not work |
| Application secrets | Written into the customer's cloud once, at onboarding. Only ARNs travel afterwards | Released to every deploy run and written by Terraform, so also held in Terraform state (`SECURITY.md` #9) |
| Upload size and type | Enforced by S3 | Not enforceable with a SAS (`SECURITY.md` #12) |
| pgvector network | Private, reachable only from the tenant's tasks | Public, reachable from Azure (`SECURITY.md` #5) |
| pgvector storage and backups | 20 GB, 1 day: the most an AWS Free plan account accepts | 32 GB, the smallest Flexible Server; 7 days |
| Deploy identity's permissions | Account-wide policy | Confined to the chatbot's resource group |
| Terraform applies per deploy | One | Two, with a fixed 90-second wait for a role grant to propagate |
| HTTPS without a domain | Through CloudFront. The load balancer also serves plain HTTP | Built in, with no plain-HTTP endpoint |
| Scaling | Fixed at one task | 1–3 replicas |
| Depends on the other cloud | No | Yes: images come from the platform's ECR, so an AWS outage blocks Azure deploys |
| Slug length | 3–21 | 3–18 |

**Disposition:** Deferred for the rollout safety, custom domain and pgvector networking. By design for the secret path (#20).

---

## 5. Scope boundary

### 28. The chatbot backend lives outside this repository

The platform deploys and configures the chatbot but does not contain it. The RAG service lives in the separate `ai-chatbot/ai-backend` repository ([`CHATBOT-LOGIC.md`](CHATBOT-LOGIC.md)). The platform controls only what Terraform puts in the chatbot's environment. The service's request limits, prompt, retrieval quality and indexing strategy (#23, #24) are outside that control. Fixes made there reach a tenant only when that tenant is redeployed with a newer image (#13). The evaluation treats the backend as a black box for the same reason (`EVALUATION.md` §7 and §10).

**Disposition: Scope.**
