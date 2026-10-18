/* eslint-disable @typescript-eslint/no-require-imports -- Standalone CommonJS figure script. */
// Figure 4.4 — Document management and indexing.
//
//   node scripts/thesis-figures/fig-4-4-document-indexing.cjs
//
// Numbered arrows, explained in the key beneath. Drawn from
// src/app/tenants/[id]/documents/{actions.ts,UploadDocumentForm.tsx},
// src/lib/docsSigner.ts and src/lib/reindex.ts; the signer is
// infra/lambda/docs-signer and infra/azure-functions/docs-signer, the resync
// is main.py, s3_loader.py, rag_service.py and vector_store.py in
// ai-chatbot/ai-backend. Nothing in storage starts indexing: no bucket
// notification or Event Grid subscription exists.
const {C, F, figure, render} = require('./lib.cjs');

const f = figure();
const COL = [24, 266, 508], CW = 190;
const mx = i => COL[i] + CW / 2;

// ── nodes ───────────────────────────────────────────────────────────────
const browser = f.node(COL[0], 18, CW, 'Operator browser', ['holds the file'], {h:86});
const cp = f.node(COL[1], 18, CW, 'Control plane', ['Next.js server actions;', 'metadata in Neon'], {h:86});

const CG = {y:136, b:392};
f.group(16, CG.y, 688, CG.b - CG.y, 'CUSTOMER CLOUD ACCOUNT', {fill:C.custTint, stroke:C.cust, nameAt:'bottom'});
const store = f.node(COL[0], 176, CW, 'Document storage', ['S3 bucket or Blob', 'container, private'], {h:70, stroke:C.cust});
const signer = f.node(COL[1], 176, CW, 'Document signer', ['Lambda or Function;', 'writes, never reads'], {h:70, stroke:C.cust});
const backend = f.node(COL[2], 176, CW, 'Chatbot backend', ['FastAPI container'], {h:70, stroke:C.cust});
const vectors = f.node(COL[2], 300, CW, 'Vector store', ['pgvector or Pinecone'], {h:58, stroke:C.cust});

// ── steps ───────────────────────────────────────────────────────────────
const gapX = (browser.r + cp.x) / 2;
f.arrow([[browser.r, 36], [cp.x, 36]]);
f.badge(gapX, 36, 1);
f.arrow([[cp.x, 61], [browser.r, 61]], 'reply');
f.badge(gapX, 61, 3);
f.arrow([[browser.r, 86], [cp.x, 86]]);
f.badge(gapX, 86, 5);

f.arrow([[mx(1) - 22, cp.b], [mx(1) - 22, signer.y]]);
f.badge(mx(1) - 22, 120, 2);
f.arrow([[mx(1) + 22, signer.y], [mx(1) + 22, cp.b]], 'reply');
f.badge(mx(1) + 22, 120, 3);

f.arrow([[mx(0), browser.b], [mx(0), store.y]], 'content');
f.badge(mx(0) - 22, 140, 4);

f.arrow([[signer.x, store.y + 35], [store.r, store.y + 35]]);
f.label((store.r + signer.x) / 2, store.y + 28, 'delete', {anchor:'middle'});

f.arrow([[cp.r, 50], [mx(2) + 30, 50], [mx(2) + 30, backend.y]]);
f.badge(mx(2) + 30, 112, 6);
f.label(mx(2) + 22, 80, 'POST /api/index', {anchor:'end'});

f.arrow([[mx(0), store.b], [mx(0), 278], [mx(2) - 40, 278], [mx(2) - 40, backend.b]], 'content');
f.badge(380, 278, 7);
f.arrow([[mx(2) + 30, backend.b], [mx(2) + 30, vectors.y]]);
f.badge(mx(2) + 30, 273, 7);

f.text(COL[0] + 4, 322, 'Storage raises no event: indexing starts', {size:F.small, fill:C.sec});
f.text(COL[0] + 4, 337, 'only when the control plane calls it (6).', {size:F.small, fill:C.sec});

// ── key ─────────────────────────────────────────────────────────────────
const KEY = [
  ['The operator asks to upload, or to delete, a document.'],
  ['The control plane calls the tenant’s document signer, authenticated by a shared secret.'],
  ['The signer returns a 60-second authorization: an S3 presigned POST or an Azure',
   'user-delegation SAS. For a deletion, the signer deletes the object itself instead.'],
  ['The browser uploads the file straight to the customer’s storage.'],
  ['The browser confirms; the control plane marks the document uploaded.'],
  ['The control plane calls the backend’s POST /api/index (public; no credential).'],
  ['The backend re-reads every document under the prefix, re-embeds it and resyncs',
   'the vector store, removing vectors of deleted documents.'],
];
let y = 422;
KEY.forEach((lines, i) => {
  f.badge(34, y - 4, i + 1);
  lines.forEach((l, j) => f.text(54, y + j * 16, l, {size:F.body, fill:C.ink}));
  y += lines.length * 16 + 8;
});

f.legend(y + 14, [['flow', 'call'], ['reply', 'response'], ['content', 'document content']]);

const H = y + 34;
render('fig-4-4-document-indexing', f.svg(H, 'Document management and indexing. The operator’s browser asks the control plane for an upload; the control plane asks the tenant’s document signer, which returns a 60-second presigned POST or user-delegation SAS (or deletes the object itself). The browser uploads the file straight to customer storage and confirms; the control plane then calls the backend’s public POST /api/index, and the backend re-reads every document and resynchronizes the vector store. Storage raises no event.'), H);
