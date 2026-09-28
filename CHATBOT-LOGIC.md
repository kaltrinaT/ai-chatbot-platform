# Chatbot Backend — Logic & Flow

> **Scope:** This documents the external `ai-chatbot/ai-backend` repository, which is **not** part of this platform repo. Backend-internal details (endpoints, embedding model, chunking) can only be verified against that repo. The runtime **environment variables** below, however, are set by this repo's Terraform and are authoritative.

The chatbot backend is a Python FastAPI service (`ai-chatbot/ai-backend`). It implements a Retrieval-Augmented Generation (RAG) pipeline: it retrieves relevant document chunks from the tenant's vector store — Pinecone or Postgres/pgvector, selected per tenant — then sends them as context to an LLM to generate an answer.

---

## Endpoints

| Endpoint | Method | Description |
|---|---|---|
| `/api/` | GET | Health / info |
| `/api/health` | GET | ALB health check target |
| `/api/ask` | POST | Answer a question using RAG |
| `/api/index` | POST | Load documents from the tenant's object storage into its vector store |
| `/docs` | GET | Swagger UI (FastAPI auto-generated) |

---

## `/ask` Request Flow

```
Client
  │
  └── POST /api/ask  { tenant_id, question, top_k }
        │
        ▼
  1. Embed question
     └── SentenceTransformer("all-MiniLM-L6-v2")
         → 384-dimension float vector
         └── model loaded lazily on first call, cached via @lru_cache
        │
        ▼
  2. Query the vector store          (VECTOR_STORE selects which)
     ├── pinecone: index.query(vector, top_k,
     │             filter={"tenant": tenant_id})
     └── pgvector: nearest-neighbour SELECT over PGVECTOR_TABLE
         → returns top-k matching chunks with metadata
         └── isolation is the dedicated index / database per tenant;
             the metadata filter is defence in depth on top of it
        │
        ▼
  3. Drop weak matches            (RETRIEVAL_MIN_SCORE, default 0.15)
     └── k-NN always returns exactly k rows, so a sparse corpus fills the
         count with off-topic filler; anything below the floor is dropped
         └── if NOTHING clears it, the backend returns
             "I don't have enough information." with sources: []
             WITHOUT calling the LLM — see the note below
        │
        ▼
  4. Build prompt
     └── context = matched chunk texts joined by "---"
         prompt = "Use ONLY the context below to answer..."
        │
        ▼
  5. Call LLM
     └── OpenAI-compatible client
         model = LLM_MODEL env var (default per provider)
         → POST {OPENAI_BASE_URL}/chat/completions
        │
        ▼
  6. Return { answer, sources }
     └── sources = list of S3 keys from chunk metadata
```

### The relevance floor is the first thing to check on "I don't have enough information."

That sentence has two entirely different causes, and they are told apart by
`sources`:

| Response | Meaning |
|---|---|
| `sources` is **empty** | Step 3 dropped everything. The LLM was never called. Either nothing is indexed, or the floor is above what the embedding model can score. |
| `sources` is **populated** | Retrieval worked; the LLM read the context and still declined. A prompt/model problem, not a retrieval one. |

The floor is an absolute cosine similarity, and `all-MiniLM-L6-v2` scores a
short question against a 200-word passage asymmetrically: a genuinely relevant
pair lands around **0.2–0.35**, and unrelated content sits near **0.05–0.11**.
A floor of 0.15 sits in that gap. Anything at or above ~0.4 is unreachable for
real prose and silently disables the chatbot — the default was 0.5 for a
while, and every tenant answered every question with the empty-`sources`
refusal above.

Note this makes the floor a coarse noise filter, not the refusal mechanism.
Deciding whether weak context actually answers the question is the prompt's
job. Calibrate with `evals/sweep_min_score.py` in the backend repo rather than
picking a number by hand.

---

## LLM Provider Routing

The container reads `OPENAI_BASE_URL` to determine which API endpoint to call. This is set by Terraform based on the tenant's `llm_provider`:

| `llm_provider` | `OPENAI_BASE_URL` | Default model |
|---|---|---|
| `openai` | `https://api.openai.com/v1` | `gpt-4o-mini` |
| `anthropic` | `https://api.anthropic.com/v1` | `claude-3-5-haiku-20241022` |
| `openrouter` | `https://openrouter.ai/api/v1` | `meta-llama/llama-3.3-70b-instruct:free` |

All three providers are called using the **OpenAI Python SDK** with a custom `base_url`. The `LLM_MODEL` env var overrides the default.

### API key lookup order (`rag_service.py`)

```python
api_key = (
    os.getenv("OPENAI_API_KEY")     # injected from Secrets Manager
    or os.getenv("LLM_API_KEY")     # fallback
    or os.getenv("OPENROUTER_API_KEY")
)
```

If none are set → **mock client** returns `[Mock Response] No API key configured`.

---

## `/index` Request Flow

```
POST /api/index  (body ignored — tenant, bucket and prefix come from the
  │               container's own TENANT_ID / S3_DOCS_BUCKET / S3_DOCS_PREFIX;
  │               one resync at a time, at most one queued, extras get 202)
  │
  ├── Load documents from the tenant's object storage
  │   ├── AWS:   S3, via s3_loader.load_text_from_s3(bucket, prefix)
  │   └── Azure: Blob Storage, reached with AZURE_STORAGE_ACCOUNT /
  │              _CONTAINER / _KEY (set by this repo's Terraform)
  │       → lists objects under prefix, reads text content
  │
  ├── For each document:
  │   ├── chunk_text(text, size=1000, overlap=200)
  │   │   → splits by words into overlapping chunks
  │   │
  │   ├── embed_texts(chunks)
  │   │   → SentenceTransformer encodes all chunks
  │   │   → returns list of 384-dim vectors
  │   │
  │   └── index.upsert(vectors)
  │       → each vector: { id, values, metadata: { tenant, source, text } }
  │       → tenant_id in metadata enables per-tenant filtering at query time
  │
  └── return { message: "Data indexed successfully" }
```

> **Note on the request body.** `triggerReindex` (`src/lib/reindex.ts`) sends the
> same `{ tenant_id, bucket, prefix }` body for both clouds, and `bucket` is
> always derived AWS-style as `chatbot-{slug}-docs`. For an Azure tenant that
> names nothing that exists; the container is expected to fall back to its
> `AZURE_STORAGE_*` settings. Whether it does can only be confirmed against the
> backend repo.

---

## Vector Store

The platform provisions **either** a Pinecone index **or** a PostgreSQL/pgvector
database per tenant, selected by the tenant's `vector_store` setting and
signalled to the container via the `VECTOR_STORE` env var. The backend
implements both paths in `vector_store.py`, which exposes one interface
(`upsert` / `query`) so `rag_service.py` is agnostic to the choice. Each
backend's driver is imported lazily inside its own branch, so a deployment
never needs the unused backend's dependency to be importable.

### `VECTOR_STORE = "pinecone"`

- **Index name**: `PINECONE_INDEX` — `chatbot-{slug}`, one **dedicated serverless index per tenant** (`pinecone_index.this`, AWS and Azure alike)
- **Dimension**: 384 (matches `all-MiniLM-L6-v2` output) · **Metric**: cosine
- **Pinecone key**: `PINECONE_API_KEY` — the **customer's own** key, collected at onboarding. On AWS it is injected from *their* Secrets Manager; on Azure from *their* Key Vault. The platform holds no standing access to the index.
- **Tenant isolation**: the index boundary itself — a container is only ever given its own index name, so no query can reach another tenant's vectors. The `{"tenant": {"$eq": tenant_id}}` metadata filter still applied on every query is now redundant defence-in-depth rather than the primary control.
- **Index quota**: Pinecone caps serverless indexes per project by plan (Starter 5, Builder 10, Standard 20, Enterprise 200). Since each tenant now uses their *own* project, this is a per-customer limit rather than a ceiling on how many tenants the platform can host.

### `VECTOR_STORE = "pgvector"`

- **Connection**: `DATABASE_URL` (alias `PGVECTOR_URL`) — a `postgresql://…?sslmode=require` URL injected from the tenant's own secret store. Password is generated by Terraform and never leaves the customer's cloud.
- **Table**: `PGVECTOR_TABLE` (default `embeddings`) · **Dimension**: `PGVECTOR_DIMENSION` (384)
- **Extension & schema**: the backend runs `CREATE EXTENSION IF NOT EXISTS vector;` plus its `CREATE TABLE` / `CREATE INDEX` on first use — there are no migrations to run. Terraform allow-lists the extension at the server level on Azure (`azure.extensions = VECTOR`); on RDS it ships with PG 16 but still needs the `CREATE EXTENSION`.
- **Tenant isolation**: a whole database instance per tenant, inside the customer's own network. Reachable only from that tenant's chatbot tasks.

---

## Embedding Model

- Model: `sentence-transformers/all-MiniLM-L6-v2` (downloaded from HuggingFace at runtime)
- Runs on CPU inside the container
- Loaded lazily on first `/ask` or `/index` call (~13s cold start for model download)
- Cached via `@lru_cache` — subsequent calls are instant

> **Note**: The model download on cold start uses significant memory. Minimum recommended ECS task memory: **4096 MB**.

---

## Environment Variables (container)

Not every variable is set on both clouds. "Secret" means an ECS task secret
resolved from Secrets Manager on AWS, and a Container App secret set by
Terraform on Azure; the plaintext exists only inside the running container
either way.

| Variable | Cloud | Source | Purpose |
|---|---|---|---|
| `TENANT_ID` | both | Terraform env | Tenant slug; the value used as the metadata filter |
| `PORT` | both | Terraform env | Uvicorn listen port (default 8000) |
| `LLM_PROVIDER` | both | Terraform env | Provider name (`openai`/`anthropic`/`openrouter`) |
| `LLM_MODEL` | both | Terraform env | Model name override |
| `OPENAI_BASE_URL` | both | Terraform env | LLM API endpoint (derived from provider) |
| `OPENAI_API_BASE` | both | Terraform env | LLM API endpoint (legacy alias) |
| `OPENAI_API_KEY` | both | secret | LLM authentication |
| `LLM_API_KEY` | both | secret | LLM authentication (fallback) |
| `ANTHROPIC_API_KEY` | both | secret | LLM authentication (fallback) |
| `VECTOR_STORE` | both | Terraform env | `pinecone` or `pgvector` — selects the retrieval backend |
| `RETRIEVAL_MIN_SCORE` | both | Terraform env | Cosine-similarity floor a chunk must clear to be used as context. Only emitted when the tenant sets `retrieval_min_score` in its `config`; otherwise the container's own default (0.15) applies |
| `PINECONE_API_KEY` | both | secret | Pinecone authentication (customer's own key) |
| `PINECONE_INDEX` | both | Terraform env | Pinecone index name (per-tenant: `chatbot-{slug}`) |
| `PINECONE_ENVIRONMENT` | **Azure only** | Terraform env | Pinecone serverless region. The AWS task definition does not set it |
| `DATABASE_URL` / `PGVECTOR_URL` | both | secret | pgvector connection URL |
| `PGVECTOR_TABLE` | both | Terraform env | Table holding embeddings (`embeddings`) |
| `PGVECTOR_DIMENSION` | both | Terraform env | Vector column width (384) |
| `S3_DOCS_BUCKET` | **AWS only** | Terraform env | S3 bucket for tenant documents |
| `S3_DOCS_PREFIX` | **AWS only** | Terraform env | Optional key prefix within bucket |
| `AWS_REGION` | **AWS only** | Terraform env | Region for the S3 SDK |
| `AZURE_STORAGE_ACCOUNT` | **Azure only** | Terraform env | Storage account holding the documents container |
| `AZURE_STORAGE_CONTAINER` | **Azure only** | Terraform env | Blob container name (`documents`) |
| `AZURE_CLIENT_ID` | **Azure only** | Terraform env | Client ID of the chatbot's user-assigned identity; tells `DefaultAzureCredential` which identity to authenticate as |

There is no `AZURE_STORAGE_KEY`, and the loader has no code path that would use
one. It always authenticates with `DefaultAzureCredential`, which resolves to
the Container App's user-assigned managed identity, selected by
`AZURE_CLIENT_ID`, and a role that can only read this tenant's documents.

The `PINECONE_*` rows apply only when `VECTOR_STORE = pinecone`, and the
`PGVECTOR_*` / `DATABASE_URL` rows only when it is `pgvector`. Terraform emits
one set or the other, never both.

---

## Error Handling

| Scenario | Response |
|---|---|
| No API key set | 200 with `[Mock Response] No API key configured` |
| LLM auth failure (401) | 500 `AuthenticationError` — check key and base URL |
| LLM quota exceeded (429) | 500 `RateLimitError` — add billing credits |
| Pinecone connection failure | 502 `Pinecone error` |
| S3 access denied | 400 or 500 depending on error code |
| AWS credentials missing | 500 `NoCredentialsError` — check ECS task role |

---

## Key Files

```
ai-chatbot/ai-backend/
  main.py          FastAPI app, route definitions, exception handlers
  rag_service.py   RAG pipeline: embedding, Pinecone query, LLM call
  vector_store.py  Pinecone client init, index creation
  s3_loader.py     S3 document loading
  models.py        Pydantic request/response models
```
