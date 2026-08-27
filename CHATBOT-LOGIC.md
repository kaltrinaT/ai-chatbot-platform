# Chatbot Backend — Logic & Flow

> **Scope:** This documents the external `ai-chatbot/ai-backend` repository, which is **not** part of this platform repo. Backend-internal details (endpoints, embedding model, chunking) can only be verified against that repo. The runtime **environment variables** below, however, are set by this repo's Terraform and are authoritative.

The chatbot backend is a Python FastAPI service (`ai-chatbot/ai-backend`). It implements a Retrieval-Augmented Generation (RAG) pipeline: it retrieves relevant document chunks from Pinecone, then sends them as context to an LLM to generate an answer.

---

## Endpoints

| Endpoint | Method | Description |
|---|---|---|
| `/api/` | GET | Health / info |
| `/api/health` | GET | ALB health check target |
| `/api/ask` | POST | Answer a question using RAG |
| `/api/index` | POST | Load documents from S3 into Pinecone |
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
  2. Query Pinecone
     └── index.query(vector, top_k, filter={"tenant": tenant_id})
         → returns top-k matching chunks with metadata
         └── tenant isolation via metadata filter
        │
        ▼
  3. Build prompt
     └── context = matched chunk texts joined by "---"
         prompt = "Use ONLY the context below to answer..."
        │
        ▼
  4. Call LLM
     └── OpenAI-compatible client
         model = LLM_MODEL env var (default per provider)
         → POST {OPENAI_BASE_URL}/chat/completions
        │
        ▼
  5. Return { answer, sources }
     └── sources = list of S3 keys from chunk metadata
```

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
POST /api/index  { tenant_id, bucket, prefix }
  │
  ├── Load documents from S3
  │   └── s3_loader.load_text_from_s3(bucket, prefix)
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

---

## Pinecone Index

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

| Variable | Source | Purpose |
|---|---|---|
| `OPENAI_API_KEY` | Secrets Manager | LLM authentication |
| `LLM_API_KEY` | Secrets Manager | LLM authentication (fallback) |
| `ANTHROPIC_API_KEY` | Secrets Manager | LLM authentication (fallback) |
| `VECTOR_STORE` | Terraform env | `pinecone` or `pgvector` — selects the retrieval backend |
| `PINECONE_API_KEY` | Secrets Manager | Pinecone authentication (customer's own key) |
| `DATABASE_URL` / `PGVECTOR_URL` | Secrets Manager / Key Vault | pgvector connection URL |
| `PGVECTOR_TABLE` | Terraform env | Table holding embeddings (`embeddings`) |
| `PGVECTOR_DIMENSION` | Terraform env | Vector column width (384) |
| `OPENAI_BASE_URL` | Terraform env | LLM API endpoint (derived from provider) |
| `OPENAI_API_BASE` | Terraform env | LLM API endpoint (legacy alias) |
| `LLM_MODEL` | Terraform env | Model name override |
| `LLM_PROVIDER` | Terraform env | Provider name (`openai`/`anthropic`/`openrouter`) |
| `PINECONE_INDEX` | Terraform env | Pinecone index name (per-tenant: `chatbot-{slug}`) |
| `PINECONE_ENVIRONMENT` | Terraform env | Pinecone serverless region |
| `S3_DOCS_BUCKET` | Terraform env | S3 bucket for tenant documents |
| `S3_DOCS_PREFIX` | Terraform env | Optional key prefix within bucket |
| `AWS_REGION` | Terraform env | Region for S3 SDK |
| `PORT` | Terraform env | Uvicorn listen port (default 8000) |

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
