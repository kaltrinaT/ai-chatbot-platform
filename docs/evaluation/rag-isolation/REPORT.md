# Targeted RAG cross-tenant privacy test (SEC-RAG-01)

Generated 2026-10-18T09:22:35.793Z by `npm run evaluate:rag-isolation` at commit `61de49007640` with uncommitted changes. Backend image `sha256:d2885e23fc87` (229647349798.dkr.ecr.us-east-1.amazonaws.com/ai-chatbot-backend:20260914-threshold-fix, 229647349798.dkr.ecr.us-east-1.amazonaws.com/ai-chatbot-backend:latest, chatbotkastriotchatbot.azurecr.io/chatbot-backend:latest, chatbotkastriotchatbot.azurecr.io/chatbot-backend:threshold-fix-20260914), built 2026-09-14T09:45:19.857020659Z.

**Result: PASS.** No probe retrieved the other tenant's data on any channel, in either layout, while every control retrieved its own canary and the negative control's leak was flagged. The tenant filter holds on its own when both tenants share one table.

## Method

The deployed backend image runs locally as two tenants, `acme` and `acme-corp` (one slug extends the other). Each holds a canary document and three fixture documents in its own bucket of a local S3 stub, indexed through `/api/index` with the body the platform sends. Every question is checked on three channels: the **answer**, the **sources** it cites, and the **prompt** the backend sent to the LLM. The LLM is a local stub that records each request and answers by echoing its whole input, the leakiest model possible, so a leak cannot hide behind a model's discretion. Probes are paired with controls (each tenant retrieves its own canary), and the shared layout ends with a negative control: the same probes against a container whose query has the tenant filter removed.

| Layout | What separates the tenants | Stands for |
|---|---|---|
| shared | Only the backend's `WHERE tenant = …` filter: both tenants in one pgvector table | The defence-in-depth layer, alone |
| separate | One database each | The platform's layout: one vector store per tenant |

## Layout: shared

Indexed: acme 4 chunks from 4 documents; acme-corp 5 chunks from 4 documents.

| Tenant | Question | Result | Answer leaks | Foreign sources | Prompts with peer data | LLM calls |
|---|---|---|---|---|---|---|
| acme | control: own canary | **PASS** | no | 0 | 0 | 1 |
| acme-corp | control: own canary | **PASS** | no | 0 | 0 | 1 |
| acme | P1: the peer's canary question | **PASS** | no | 0 | 0 | 1 |
| acme | P2: the peer's canary sentence, verbatim (a near-duplicate embedding) | **PASS** | no | 0 | 0 | 1 |
| acme | P3: top_k 10000: everything the store will return | **PASS** | no | 0 | 0 | 1 |
| acme | P4: the peer's tenant named in the request body | **PASS** | no | 0 | 0 | 1 |
| acme | P5: a prompt injection asking for the peer's data | **PASS** | no | 0 | 0 | 1 |
| acme | P6: a filter-injection string as the question | **PASS** | no | 0 | 0 | 0 |
| acme-corp | P1: the peer's canary question | **PASS** | no | 0 | 0 | 1 |
| acme-corp | P2: the peer's canary sentence, verbatim (a near-duplicate embedding) | **PASS** | no | 0 | 0 | 1 |
| acme-corp | P3: top_k 10000: everything the store will return | **PASS** | no | 0 | 0 | 1 |
| acme-corp | P4: the peer's tenant named in the request body | **PASS** | no | 0 | 0 | 1 |
| acme-corp | P5: a prompt injection asking for the peer's data | **PASS** | no | 0 | 0 | 1 |
| acme-corp | P6: a filter-injection string as the question | **PASS** | no | 0 | 0 | 1 |

| Check | Tenant | What | Result | Peer rows unchanged | Own rows before → after |
|---|---|---|---|---|---|
| I1 | acme | reindex request naming the peer's tenant, bucket and an empty prefix | **PASS** | true | 4 → 4 |
| I2 | acme | reindex request with a caller-chosen prefix that matches nothing | **PASS** | true | 4 → 0 |
| I3 | acme | a deleted document is purged, and only from its own tenant | **PASS** | true | 4 → 3 |
| I4 | acme | one tenant's reindex leaves the other's chunks alone when their vector ids coincide | **FAIL** (integrity) | false | 4 → 5 |

Negative control (acme with the tenant filter removed from its query; patch applied: true): P1 leak flagged, P2 leak flagged. **The probes detect a leak when the filter is missing.**

## Layout: separate

Indexed: acme 4 chunks from 4 documents; acme-corp 5 chunks from 4 documents.

| Tenant | Question | Result | Answer leaks | Foreign sources | Prompts with peer data | LLM calls |
|---|---|---|---|---|---|---|
| acme | control: own canary | **PASS** | no | 0 | 0 | 1 |
| acme-corp | control: own canary | **PASS** | no | 0 | 0 | 1 |
| acme | P1: the peer's canary question | **PASS** | no | 0 | 0 | 1 |
| acme | P2: the peer's canary sentence, verbatim (a near-duplicate embedding) | **PASS** | no | 0 | 0 | 1 |
| acme | P3: top_k 10000: everything the store will return | **PASS** | no | 0 | 0 | 1 |
| acme-corp | P1: the peer's canary question | **PASS** | no | 0 | 0 | 1 |
| acme-corp | P2: the peer's canary sentence, verbatim (a near-duplicate embedding) | **PASS** | no | 0 | 0 | 1 |
| acme-corp | P3: top_k 10000: everything the store will return | **PASS** | no | 0 | 0 | 1 |

| Check | Tenant | What | Result | Peer rows unchanged | Own rows before → after |
|---|---|---|---|---|---|
| I1 | acme | reindex request naming the peer's tenant, bucket and an empty prefix | **PASS** | true | 4 → 4 |
| I2 | acme | reindex request with a caller-chosen prefix that matches nothing | **PASS** | true | 4 → 0 |
| I3 | acme | a deleted document is purged, and only from its own tenant | **PASS** | true | 4 → 3 |

## Findings

- **Vector ids are not unique across tenants in a shared store.** The backend names a chunk `<tenant>-<key>-<n>` and upserts on that id. With slugs `acme` and `acme-corp`, acme's `corp-collide.txt` and acme-corp's `collide.txt` get the same id `acme-corp-collide.txt-0`; acme's reindex took the row over (now acme, holding acme's text), and acme-corp lost its document. Integrity, not confidentiality: the row moves with its tenant column, so neither tenant reads the other's text. Not reachable on the platform, where each tenant has its own store and docs-signer keys start with a UUID; it matters only if stores were ever shared.
- **Within one tenant: a caller-chosen prefix empties the tenant's own index.** `/api/index` in this image takes `prefix` from the request body; a prefix matching nothing found no documents, and the resync's purge then deleted every one of the tenant's chunks (4 → 0 in the shared layout, 4 → 0 in the separate layout). The other tenant's rows were untouched. /api/index is public, so anyone can do this to any tenant; a reindex restores it. The backend working copy no longer reads the prefix from the body (uncommitted, not in this image).
- **Within one tenant: top_k is unbounded.** `AskRequest.top_k` has no upper bound, and one request with top_k 10000 returned every chunk that cleared the relevance gate (3 of 4 for acme, 5 of 5 for acme-corp), all the tenant's own. Not a cross-tenant leak, but any visitor of the public chatbot can pull as much of a knowledge base into one prompt as clears the gate.
- **Developer files shipped in the backend image.** `/app/.env.local` (1392 bytes, sets VERCEL_OIDC_TOKEN; a token from https://oidc.vercel.com/kaltrina127316s-projects that expired 2026-09-13T22:11:22.000Z), `/app/.vercel/project.json` (124 bytes), `/app/.vercel/README.txt` (520 bytes). The backend's .dockerignore excludes `.env` but not `.env.local` or `.vercel/`, and the platform copies the same image into every customer's registry, so each customer receives them.

## Image provenance

Backend source hashes (sha256): `main.py` c3596628e966, `models.py` ead23272b78f, `rag_service.py` 91438737e06a, `vector_store.py` a83c3aeb1036, `s3_loader.py` c36592cf0f5b. Settings in the image: `/app/rag_service.py:229:        min_score = float(os.getenv("RETRIEVAL_MIN_SCORE", "0.15"))`; `/app/rag_service.py:152:        chunks = chunk_text(text, size=200, overlap=40)`; `/app/main.py:80:    prefix = req.prefix if req.prefix is not None else os.getenv("S3_DOCS_PREFIX", "")`.

| File in the image | Bytes | Variables | Credential patterns | Tokens |
|---|---:|---|---|---|
| `/app/.env.local` | 1392 | VERCEL_OIDC_TOKEN | jwt | https://oidc.vercel.com/kaltrina127316s-projects, exp 2026-09-13T22:11:22.000Z (expired) |
| `/app/.vercel/project.json` | 124 |  | — |  |
| `/app/.vercel/README.txt` | 520 |  | — |  |

## Limits

- Local, not live: the backend image is the deployed one, but Postgres, S3 and the LLM are local stand-ins. The live counterpart is S1, which needs two deployed tenants.
- pgvector only. The Pinecone path (cells A1 and B1) applies the same tenant filter as a Pinecone metadata filter and is not exercised here.
- The separate layout uses two databases on one server in place of two database instances; the backend cannot tell the difference, since it only sees its own connection string.
- A probe set shows the absence of the leaks it looks for, not of every leak.

## Reproducing

`npm run evaluate:rag-isolation` (Docker; about 5 minutes, the first run also downloads the embedding model into the Docker volume `rag-isolation-hf-cache`). `-- --image <ref>` tests another build, e.g. the backend working copy's `ai-chatbot-backend:latest`. Every request, answer and stub record is in `results.json`.
