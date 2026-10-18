/* eslint-disable @typescript-eslint/no-require-imports -- Standalone CommonJS figure script. */
// Figure 4.5 — RAG processing pipeline.
//
//   node scripts/thesis-figures/fig-4-5-rag-pipeline.cjs
//
// Indexing on the left, answering a question on the right, and what the two
// share in the middle. Parameters are the backend's own: chunk_text(size=200,
// overlap=40) and index_tenant_data in rag_service.py, all-MiniLM-L6-v2 (384
// dimensions), AskRequest.top_k = 5 in models.py, RETRIEVAL_MIN_SCORE default
// 0.15 in filter_by_relevance, temperature 0.2, and the fixed reply when no
// chunk passes, returned without calling the LLM.
const {C, F, figure, render} = require('./lib.cjs');

const f = figure();
const L = {x:28, w:186}, M = {x:254, w:212}, R = {x:506, w:186};
const NH = 50, STEP = 66;
const midY = n => n.y + n.h / 2;
// Rows are shared across the three columns, so that the two embed steps sit
// level with the model they share and each link is a straight line.
const row = i => 64 + i * STEP;

// ── indexing ────────────────────────────────────────────────────────────
f.group(16, 16, 210, row(3) + NH + 14 - 16, 'INDEXING', {fill:C.custTint, stroke:C.cust, sub:'on every POST /api/index'});
const docs = f.node(L.x, row(0), L.w, 'Documents', ['the tenant’s S3 or Blob'], {h:NH});
const extract = f.node(L.x, row(1), L.w, 'Extract text', ['.txt, .pdf, .docx'], {h:NH});
const chunk = f.node(L.x, row(2), L.w, 'Chunk', ['200 words, 40 overlapping'], {h:NH});
const embedDoc = f.node(L.x, row(3), L.w, 'Embed', ['one vector per chunk'], {h:NH});
[[docs, extract], [extract, chunk], [chunk, embedDoc]].forEach(([a, b]) => f.arrow([[a.cx, a.b], [b.cx, b.y]]));

// ── answering ───────────────────────────────────────────────────────────
const QY = row(2) - 46;
const q = f.node(R.x, row(2), R.w, 'Question', ['from the chat UI'], {h:NH});
const embedQ = f.node(R.x, row(3), R.w, 'Embed question', ['with the same model'], {h:NH});
const retrieve = f.node(R.x, row(4), R.w, 'Retrieve', ['top 5 by cosine, this tenant'], {h:NH});
const filter = f.node(R.x, row(5), R.w, 'Similarity filter', ['keep score ≥ 0.15'], {h:NH});
const prompt = f.node(R.x, row(6), R.w, 'Grounded prompt', ['“use ONLY the context”'], {h:NH});
const llm = f.node(R.x, row(7), R.w, 'External LLM', ['OpenAI-compatible API', ['a third party', {fill:C.warn}]], {h:62, dash:true, stroke:C.ext});
const answer = f.node(R.x, row(7) + 78, R.w, 'Answer', ['text + source documents'], {h:NH});
f.group(494, QY, 210, answer.b + 14 - QY, 'QUERY', {fill:C.cpTint, stroke:C.cp, sub:'each POST /api/ask'});
[[q, embedQ], [embedQ, retrieve], [retrieve, filter], [filter, prompt], [prompt, llm], [llm, answer]].forEach(([a, b]) => f.arrow([[a.cx, a.b], [b.cx, b.y]]));

// ── shared, in the backend container ────────────────────────────────────
f.text(M.x + M.w / 2, row(3) - 16, 'SHARED BY BOTH', {size:F.group, weight:'bold', fill:C.sec, anchor:'middle'});
const model = f.node(M.x, row(3), M.w, 'all-MiniLM-L6-v2', ['384 values; on the CPU'], {h:NH, fill:'#fbfbfa'});
const store = f.node(M.x, row(4) - 7, M.w, 'Vector store', ['pgvector or Pinecone:', 'vector, chunk text, source'], {h:64, stroke:C.cust});
const fallback = f.node(M.x, row(5) + 4, M.w, 'Fixed reply', ['“I don’t have enough', 'information.” LLM not called'], {h:64, stroke:C.warn, titleFill:C.warn});

// The model is used by both embed steps.
f.arrow([[embedDoc.r, midY(model)], [model.x, midY(model)]], 'link');
f.arrow([[model.r, midY(model)], [embedQ.x, midY(model)]], 'link');

f.arrow([[embedDoc.cx, embedDoc.b], [embedDoc.cx, midY(store)], [store.x, midY(store)]]);
f.label((embedDoc.cx + store.x) / 2 + 20, midY(store) - 7, 'upsert', {anchor:'middle'});
f.arrow([[store.r, midY(retrieve)], [retrieve.x, midY(retrieve)]]);
f.label((store.r + retrieve.x) / 2, midY(retrieve) - 7, 'query', {anchor:'middle'});

f.arrow([[filter.x, midY(filter)], [fallback.r, midY(filter)]]);
f.label(486, midY(filter) + 19, 'none pass', {anchor:'middle'});
f.arrow([[fallback.cx, fallback.b], [fallback.cx, midY(answer)], [answer.x, midY(answer)]], 'reply');

const LY = answer.b + 44;
f.legend(LY, [['flow', 'data flow'], ['link', 'uses'], ['box-dash', 'outside the customer’s account']]);

const H = LY + 18;
render('fig-4-5-rag-pipeline', f.svg(H, 'RAG processing pipeline. Indexing extracts text from the tenant’s documents, splits it into 200-word chunks overlapping by 40 words, embeds each with all-MiniLM-L6-v2 into 384 values and upserts it into the vector store. A question is embedded with the same model, the five nearest chunks by cosine similarity are retrieved for this tenant, those scoring below 0.15 are dropped, and the remainder form a context-only prompt for an external OpenAI-compatible LLM, whose answer returns with its source documents. If no chunk passes, a fixed reply is returned without calling the LLM.'), H);
