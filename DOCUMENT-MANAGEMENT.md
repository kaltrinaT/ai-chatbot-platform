# Document Management — How It Works

This explains, step by step, how a tenant's knowledge-base documents are uploaded, listed and deleted from the platform's UI, and why it is built this way. It covers both clouds: AWS (S3, a Lambda) and Azure (Blob Storage, a Function App).

See `ARCHITECTURE.md` for the control-plane/data-plane boundary this feature has to respect, and `CHATBOT-LOGIC.md` for what the chatbot backend does with the documents once they are indexed.

---

## The rule this design has to satisfy

`ARCHITECTURE.md` states the platform must never hold "any endpoint, IAM role, or delegated access that would give the platform visibility into runtime traffic, documents, or logs." A document upload feature is, on its face, exactly that kind of access. The whole design exists to let an operator manage documents *without* the platform ever holding a cloud credential that can read, write or list the tenant's storage.

The component that can touch storage lives **inside the tenant's own cloud**, not the platform. The platform only ever speaks plain HTTPS to it.

---

## The moving pieces

| Piece | Lives in | What it can do |
|---|---|---|
| **docs-signer**, AWS: Lambda (`infra/lambda/docs-signer/`) | Tenant's AWS account | `s3:PutObject` and `s3:DeleteObject` on the docs bucket, under the tenant's prefix. Never `GetObject`, never `ListBucket`. |
| **docs-signer**, Azure: Function App `chatbot-<slug>-docs-signer` (`infra/azure-functions/docs-signer/`) | Tenant's resource group | A custom role on the docs storage account: `generateUserDelegationKey`, `blobs/write`, `blobs/delete`. Never read, never list. |
| **Platform (Next.js server)** | Platform's own infrastructure | No cloud credential for documents at all. Calls the docs-signer over HTTPS with a shared-secret header. |
| **`tenant_documents` table** | Platform's Postgres | The list of documents the UI shows. The platform fills it itself; it never asks storage. |
| **Browser** | Operator's machine | Does the actual upload, sending the file bytes straight to storage with a short-lived signed URL. Bytes never pass through the platform's server. |

---

## Step 1 — Provisioning, at tenant deploy time

Before any document can be uploaded, the tenant needs its own docs-signer. It is created by the normal deploy.

1. **Onboarding** (`src/app/tenants/new/actions.ts`) generates a random 32-byte shared secret. The platform keeps an AES-256-GCM encrypted copy (`tenants.docsSignerSecretEncrypted`), because it needs the plaintext again to call the signer, and fetching it from the tenant's cloud each time would mean holding a credential for that cloud.
   - **AWS:** the secret is also written to the tenant's Secrets Manager as `{slug}/docs-signer-secret` (`ensureDocsSignerSecret` in `src/lib/aws.ts`), and only its **ARN** (`tenants.docsSignerSecretArn`) travels through the workflow.
   - **Azure:** nothing is written at onboarding, since the tenant's Key Vault does not exist yet. The deploy run fetches the secret from the platform once (`POST /api/deployments/{id}/secrets`, see `SECURITY.md`) and Terraform sets it as the Function App's `DOCS_SIGNER_SECRET` app setting. The Function reads no secret store and has no Key Vault access.
2. **The deploy workflow** packages the signer and passes `platform_origin` to Terraform. On AWS, `deploy-tenant.yml` installs the Lambda's dependencies and passes `docs_signer_secret_arn`. On Azure, `deploy-tenant-azure.yml` publishes the Function's code after `terraform apply`.
3. **Terraform** creates:
   - **AWS** (`infra/terraform/main.tf`): the Lambda, its IAM role (`s3:PutObject`/`s3:DeleteObject` on `{bucket}/{prefix}*`, `secretsmanager:GetSecretValue` on that one ARN), and a Function URL with `authorization_type = "NONE"`. Authentication happens inside the handler instead.
   - **Azure** (`infra/terraform/azure/main.tf`): the Function App with a system-assigned identity and the custom role above, scoped to the docs storage account. The Function's HTTP trigger is anonymous for the same reason.
   - **Both:** a CORS rule on the docs storage, so the browser's direct upload in Step 2 is allowed. See "Where uploads may come from" below.
4. The workflow reports the `docs_signer_url` output back through the deployment-status webhook, or the outputs artifact if the webhook is lost. It lands in `tenants.docsSignerUrl` only after `acceptDocsSignerUrl` (`src/lib/docsSigner.ts`) checks it. An Azure URL is fully determined by the slug. An AWS URL must have the shape of a Function URL in the tenant's region, and once recorded it is never replaced by a later callback. The URL is checked again before every call, because it is where the platform sends the secret.
5. **An AWS tenant without the secret is refused.** Onboarding always creates it before the tenant row exists, so `triggerDeployment` in `src/lib/deploy.ts` treats a missing `docsSignerSecretArn` (AWS) or `docsSignerSecretEncrypted` (Azure) as an inconsistent tenant and refuses to dispatch. That keeps a redeploy from ever calling into the customer's AWS account: onboarding is the only time the platform assumes a customer role itself.

Until the first deploy succeeds, the tenant page shows "Document upload will be available here once the first deployment succeeds" instead of the upload UI.

---

## Step 2 — Uploading a document

```
Browser                  Platform server              docs-signer               Storage
   │                            │                              │                 │
   │ pick file(s)               │                              │                 │
   │──requestUploadUrl()───────►│                              │                 │
   │  (fileName, type, size)    │──POST {action:               │                 │
   │                            │   "presign-upload", ...}────►│                 │
   │                            │  x-docs-signer-secret header │                 │
   │                            │                              │ mint objectKey  │
   │                            │                              │ sign upload     │
   │                            │◄──{objectKey, url[, fields]}─│                 │
   │                            │ INSERT tenant_documents       │                 │
   │                            │   (status: "pending")         │                 │
   │◄──{documentId, url, ...}──│                              │                 │
   │                                                                             │
   │──AWS: POST url, fields + file bytes / Azure: PUT url, file bytes ─────────►│
   │◄──────────────────────────────────────────────────────── 2xx ─────────────│
   │                            │                              │                 │
   │──confirmUpload(documentId)►│                              │                 │
   │                            │ UPDATE status: "uploaded"     │                 │
   │                            │──POST {chatbot}/api/index (reindex)            │
   │◄──{ok}─────────────────────│                              │                 │
```

1. The operator picks a file in `UploadDocumentForm.tsx` (client component).
2. It calls `requestUploadUrl(tenantId, fileName, contentType, sizeBytes)`, a server action (`src/app/tenants/[id]/documents/actions.ts`). It checks the caller owns the tenant, then calls `presignUpload` (`src/lib/docsSigner.ts`), which POSTs to the tenant's `docsSignerUrl` with the shared-secret header.
3. The signer compares the secret in constant time, checks the content type against an allow-list and the size against the configured maximum (25 MB by default), and mints a UUID-prefixed object key under the tenant's prefix. Then:
   - **AWS:** it calls `createPresignedPost` with S3 policy conditions for the same size limit and content type. S3 itself enforces them, so a modified client cannot skip them.
   - **Azure:** it asks Blob Storage for a user-delegation key as its own identity and signs a SAS for that one blob: create and write only, content type pinned, valid for 60 seconds. A SAS cannot limit the size of what is written, so the size check happens only before signing (`SECURITY.md` #12).
4. The server action inserts a `tenant_documents` row with `status: "pending"` and returns the signed URL to the browser.
5. **The browser, not the platform, sends the file straight to storage**: a multipart POST with the policy fields on AWS, a single PUT with `x-ms-blob-type: BlockBlob` on Azure. This step keeps document content out of the platform entirely.
6. On success, the browser calls `confirmUpload(documentId)`, which marks the row `"uploaded"` and triggers a reindex (Step 4). On failure it calls `abandonUpload(documentId)`, which removes the row if it is still pending.

### Where uploads may come from

The upload in step 5 is a cross-origin request from the platform's page to the tenant's storage, so the storage's CORS rule decides whether the browser may send it. Terraform builds the allowed origins from two values:

- `PLATFORM_BASE_URL`, the GitHub secret naming the platform's address
- `EXTRA_CORS_ORIGIN`, an optional GitHub repository variable for a second address, such as `http://localhost:3000` for a control plane run on a developer machine

Azure matches the browser's `Origin` exactly: scheme, host and port, with no trailing slash. An upload from any other address fails before a byte is sent, and the form reports "Couldn't reach your cloud storage". The rule changes only on the tenant's next deploy, so after changing either value, redeploy the tenant.

---

## Step 3 — Deleting a document

No bytes are involved, and the signer does the delete itself:

1. `DeleteDocumentButton.tsx` calls `deleteDocument(documentId)`.
2. The server action verifies ownership, then calls `deleteViaSigner` (`src/lib/docsSigner.ts`), which POSTs `{action: "delete", objectKey}` to the signer.
3. The signer checks the key is inside the tenant's prefix, on top of its role's scoping, and deletes the object with its own credentials.
4. The `tenant_documents` row is hard-deleted. That row *is* the platform's only record that the document existed, since the platform never lists storage.
5. A reindex is triggered, as after an upload.

---

## Step 4 — Reindexing

Neither upload nor delete changes what the chatbot answers from until the backend re-embeds. Both `confirmUpload` and `deleteDocument` call `triggerReindex` (`src/lib/reindex.ts`), which POSTs to the tenant's own `/api/index`. For a tenant fronted by CloudFront, that call goes to the load balancer directly, because CloudFront gives up after 60 seconds and a reindex is allowed 120.

What the backend does with it (in the separate `ai-chatbot/ai-backend` repository):

- **It takes nothing from the request.** The platform still sends `tenant_id`, `bucket` and `prefix`, and the backend ignores them. It reads its tenant, bucket or container, and prefix from the environment Terraform gave it, because `/api/index` is public and unauthenticated.
- **It is a full resync.** Every call re-reads and re-embeds *every* document under the prefix, not just the one that changed.
- **It removes deleted documents from the index.** After embedding, it deletes the vectors of every document no longer in storage, in Pinecone and pgvector alike. A deleted document stops being used for answers once that reindex succeeds.
- **One resync runs at a time.** At most one more waits behind it, and further requests are answered `202` at once, because the waiting resync will already include them.

The platform waits up to 120 seconds. A larger corpus can take longer, and the operator then sees a warning for a reindex that is still running and will succeed (`LIMITATIONS.md` #8).

---

## Why the platform never holds a cloud credential for this

Two weaker designs were considered and rejected:

1. **The platform uses the tenant's deployment identity** to touch storage directly. Rejected: that identity can read everything, so only "the application code doesn't happen to call `GetObject`" would stop the platform reading documents, which is a convention, not a boundary.
2. **The platform holds a new, narrower write-and-delete identity.** Better, but the platform would still hold *some* credential that can write to the tenant's storage, and a compromised platform could tamper with or delete documents without going through anything in the tenant's cloud.

The docs-signer avoids both. The platform never assumes a role for documents, never holds a storage key, and never points a cloud SDK at the tenant's storage. It holds an HTTPS URL and a shared secret, which can at most ask the signer to sign an upload or perform a delete, within the signer's own narrow role. `SECURITY.md` #2 covers what that secret still allows.

---

## Data model

```
tenants
  docs_signer_secret_arn         -- AWS only: Secrets Manager ARN (written once, at onboarding)
  docs_signer_secret_encrypted   -- platform's own encrypted copy, for calling the signer
  docs_signer_url                -- signer URL, recorded after the first deploy

tenant_documents
  id, tenant_id
  object_key       -- minted by the signer, never client-supplied
  display_name, content_type, size_bytes
  status           -- pending | uploaded | failed
  uploaded_by_user_id, created_at, updated_at
```

---

## File reference

| File | Role |
|---|---|
| `infra/lambda/docs-signer/index.mjs` | AWS signer: presign, delete, auth |
| `infra/azure-functions/docs-signer/src/functions/docsSigner.js` | Azure signer: user-delegation SAS, delete, auth |
| `infra/terraform/main.tf` | Lambda, its IAM role, Function URL, bucket CORS |
| `infra/terraform/azure/main.tf` | Function App, its custom role, storage CORS |
| `.github/workflows/deploy-tenant.yml`, `deploy-tenant-azure.yml` | Package the signer, pass variables, report the signer URL |
| `src/lib/aws.ts` (`ensureDocsSignerSecret`), `src/lib/azure.ts` (`generateDocsSignerSecret`) | Generate the shared secret once |
| `src/lib/docsSigner.ts` | Platform's HTTPS client for the signer, and the URL checks |
| `src/lib/reindex.ts` | Triggers `/api/index` on the tenant's chatbot |
| `src/app/tenants/[id]/documents/actions.ts` | Server actions: request URL, confirm, abandon, delete |
| `src/app/tenants/[id]/documents/*.tsx` | The UI |
| `src/db/schema.ts` | `tenant_documents` and the docs-signer columns on `tenants` |
