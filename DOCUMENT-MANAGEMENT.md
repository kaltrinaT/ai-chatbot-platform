# Document Management — How It Works

This explains, step by step, how a tenant's knowledge-base documents get uploaded, listed, and deleted from the platform's UI — and why it's built the way it is. AWS only; Azure isn't wired up yet.

See `ARCHITECTURE.md` for the broader control-plane/data-plane boundary this feature has to respect, and `CHATBOT-LOGIC.md` for what the chatbot backend does with the documents once they're indexed.

---

## The rule this design has to satisfy

`ARCHITECTURE.md` states the platform must never hold "any endpoint, IAM role, or delegated access that would give the platform visibility into runtime traffic, documents, or logs." A document upload feature is, on its face, exactly that kind of access — so the whole design exists to let an operator manage documents *without* the platform ever holding an AWS credential capable of reading, writing, or listing the bucket.

The trick: the component that can actually touch S3 lives **inside the tenant's own AWS account**, not the platform. The platform only ever speaks plain HTTPS to it.

---

## The moving pieces

| Piece | Lives in | What it can do |
|---|---|---|
| **docs-signer Lambda** (`infra/lambda/docs-signer/`) | Tenant's AWS account | `s3:PutObject` + `s3:DeleteObject` on the docs bucket, under the tenant's prefix. Never `GetObject`, never `ListBucket`. |
| **Platform (Next.js server)** | Platform's own infra | No AWS credential for documents at all. Calls the Lambda's Function URL over HTTPS with a shared-secret header. |
| **`tenant_documents` table** | Platform's Postgres | The list of "what documents exist" the UI reads from — populated by the platform itself, not by asking S3. |
| **Browser** | Operator's machine | Does the actual upload — POSTs file bytes straight to S3 using a presigned URL. Bytes never pass through the platform's server. |

---

## Step 1 — Provisioning, at tenant deploy time

Before any document can be uploaded, the tenant needs its own docs-signer Lambda. This happens automatically as part of the normal AWS deploy:

1. **Onboarding** (`src/app/tenants/new/actions.ts`): while writing the tenant's LLM/Pinecone secrets into their Secrets Manager (the platform already does this via `assumeTenantRole`), it also generates a random 32-byte secret and writes it to `{slug}/docs-signer-secret` via the same `writeTenantSecret` call — see `ensureDocsSignerSecret` in `src/lib/aws.ts`. The platform keeps its own AES-256-GCM encrypted copy of that same value (`tenants.docsSignerSecretEncrypted`) — it needs the plaintext again later to call the Lambda, and re-fetching it from AWS on every operation would mean touching tenant AWS credentials on an ongoing basis, which defeats the point. Only the secret's **ARN** (`tenants.docsSignerSecretArn`) is what actually travels through Terraform.
2. **GitHub Actions** (`deploy-tenant.yml`) installs the Lambda's dependencies (`npm install --production` in `infra/lambda/docs-signer/`) and passes `docs_signer_secret_arn` + `platform_origin` to `terraform apply`.
3. **Terraform** (`infra/terraform/main.tf`) creates:
   - the Lambda itself, zipped via `archive_file`
   - its IAM role — `s3:PutObject`/`s3:DeleteObject` on `{bucket}/{prefix}*` and `secretsmanager:GetSecretValue` scoped to just that one ARN
   - a Function URL (`authorization_type = "NONE"` — no AWS SigV4 required to call it; auth happens inside the handler instead)
   - CORS on the docs bucket, so the browser's direct upload in Step 2 is allowed
4. The workflow reads the new `docs_signer_url` Terraform output and posts it back through the existing deployment-status webhook, same as `chatbotUrl`/`albDnsName` always have been. It lands in `tenants.docsSignerUrl`.
5. **Existing tenants** (onboarded before this feature existed) get the secret lazily: `triggerDeployment` in `src/lib/deploy.ts` checks for a missing `docsSignerSecretArn` and generates one on their next redeploy — no manual DB fix needed.

Until this finishes, the tenant page shows "Document upload will be available here once the first deployment succeeds" instead of the upload UI.

---

## Step 2 — Uploading a document

```
Browser                  Platform server              docs-signer Lambda        S3
   │                            │                              │                 │
   │ pick file(s)               │                              │                 │
   │──requestUploadUrl()───────►│                              │                 │
   │  (fileName, type, size)    │──POST /  {action:            │                 │
   │                            │   "presign-upload", ...}────►│                 │
   │                            │  x-docs-signer-secret header │                 │
   │                            │                              │ mint objectKey  │
   │                            │                              │ createPresigned │
   │                            │                              │   Post()        │
   │                            │◄──{objectKey, url, fields}───│                 │
   │                            │ INSERT tenant_documents       │                 │
   │                            │   (status: "pending")         │                 │
   │◄──{documentId, url, ...}──│                              │                 │
   │                                                                             │
   │──POST url, fields + file bytes ───────────────────────────────────────────►│
   │◄──────────────────────────────────────── 204 ────────────────────────────│
   │                            │                              │                 │
   │──confirmUpload(documentId)►│                              │                 │
   │                            │ UPDATE status: "uploaded"     │                 │
   │                            │──POST {chatbotUrl}/api/index (reindex)         │
   │◄──{ok}─────────────────────│                              │                 │
```

1. The operator picks a file in `UploadDocumentForm.tsx` (client component).
2. It calls `requestUploadUrl(tenantId, fileName, contentType, sizeBytes)` — a server action (`src/app/tenants/[id]/documents/actions.ts`). This checks the caller owns the tenant, then calls `presignUpload` (`src/lib/docsSigner.ts`), which POSTs to the tenant's `docsSignerUrl` with the shared secret header.
3. The Lambda validates the secret (`timingSafeEqual`, same pattern as the platform's own deployment-status webhook), checks the content-type against an allow-list and the size against the configured max, mints a UUID-prefixed object key under the tenant's prefix, and calls `createPresignedPost` with S3 policy conditions enforcing that same size limit and content-type — so the limits are enforced by S3 itself, not just app-level checks that a modified client could skip.
4. The server action inserts a `tenant_documents` row with `status: "pending"` and returns the presigned `url`/`fields` to the browser.
5. **The browser — not the platform — POSTs the file directly to S3** using those fields. This is the step that keeps document content out of the platform entirely.
6. On success, the browser calls `confirmUpload(documentId)`, which flips the row to `"uploaded"` and triggers a reindex (see Step 4).

---

## Step 3 — Deleting a document

Simpler, because no bytes are involved either way — the Lambda does the delete itself:

1. `DeleteDocumentButton.tsx` calls `deleteDocument(documentId)`.
2. The server action verifies ownership, then calls `deleteViaSigner` (`src/lib/docsSigner.ts`), which POSTs `{action: "delete", objectKey}` to the Lambda.
3. The Lambda re-validates the key is inside the tenant's prefix (defense in depth on top of the IAM scoping) and calls `DeleteObjectCommand` with its own credentials.
4. The `tenant_documents` row is hard-deleted — that row *is* the platform's only record that the document ever existed, since the platform never calls `s3:ListBucket`.
5. A reindex is triggered, same as after an upload.

---

## Step 4 — Reindexing

Neither upload nor delete makes a document searchable by itself — the chatbot backend has to re-embed it. Both `confirmUpload` and `deleteDocument` call `triggerReindex` (`src/lib/reindex.ts`), which POSTs `{tenant_id, bucket, prefix}` to the tenant's own `{chatbotUrl}/api/index`.

**Two limitations worth knowing, both confirmed from `CHATBOT-LOGIC.md` and not fixable from this repo** (that endpoint lives in the separate `ai-chatbot/ai-backend` repo):

- **It's a full resync**, not an incremental update — every call re-reads and re-embeds *every* document under the prefix, not just the one that changed.
- **It never purges.** Deleting a document removes it from S3 and from the platform's list, but its already-generated vectors stay in Pinecone/pgvector until something else cleans them up. The UI and `CLIENT-DEPLOYMENT-GUIDE.md` both call this out.

---

## Why the platform never holds an AWS credential for this

Two weaker designs were considered and rejected:

1. **The platform assumes the tenant's existing `deploymentRoleArn`** (already used for LLM/Pinecone secrets) to touch S3 directly. Rejected — that role has `s3:*`, so this would mean the platform can read documents; only "the application code doesn't happen to call `GetObject`" would stop it, which is a convention, not a boundary.
2. **The platform assumes a new, narrower Put/Delete-only role.** Better, but the platform would still hold *some* AWS credential capable of writing to the bucket — a compromised platform credential could still tamper with or delete a tenant's documents.

The docs-signer Lambda avoids both: the platform never calls `AssumeRole` for documents, never holds an AWS access key for the bucket, and never has an AWS SDK client pointed at it. The only thing it holds is an HTTPS URL and a shared secret — a credential that can, at most, ask the Lambda to sign an upload or perform a delete, scoped by the Lambda's own narrow role.

---

## Data model

```
tenants
  docs_signer_secret_arn         -- Secrets Manager ARN (written once, onboarding)
  docs_signer_secret_encrypted   -- platform's own encrypted copy, for calling the Lambda
  docs_signer_url                -- Lambda Function URL, populated post-deploy

tenant_documents
  id, tenant_id
  object_key       -- minted by the Lambda, never client-supplied
  display_name, content_type, size_bytes
  status           -- pending | uploaded | failed
  uploaded_by_user_id, created_at, updated_at
```

---

## File reference

| File | Role |
|---|---|
| `infra/lambda/docs-signer/index.mjs` | The Lambda handler — presign, delete, auth |
| `infra/terraform/main.tf` | Lambda, its IAM role, Function URL, bucket CORS |
| `.github/workflows/deploy-tenant.yml` | Installs Lambda deps, passes vars, relays the Function URL back |
| `src/lib/aws.ts` — `ensureDocsSignerSecret` | Generates + writes the shared secret once |
| `src/lib/docsSigner.ts` | Platform's HTTPS client for the Lambda |
| `src/lib/reindex.ts` | Triggers `/api/index` on the tenant's chatbot |
| `src/app/tenants/[id]/documents/actions.ts` | Server actions: request URL, confirm, delete |
| `src/app/tenants/[id]/documents/*.tsx` | The UI |
| `src/db/schema.ts` | `tenant_documents` table + the three new `tenants` columns |
