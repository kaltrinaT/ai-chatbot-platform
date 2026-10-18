/* eslint-disable @typescript-eslint/no-require-imports -- Standalone CommonJS figure script. */
// Thesis figure: how an uploaded document becomes searchable.
//
//   fig-27-document-indexing   the reindex an upload or delete triggers, from
//                              the control plane's call to the stored vectors
//
//   node scripts/plot-document-indexing.cjs
//
// Drawn from the code rather than from data: src/app/tenants/[id]/documents/
// actions.ts and src/lib/reindex.ts on the platform side; main.py,
// s3_loader.py, rag_service.py and vector_store.py in ai-chatbot/ai-backend
// for the pipeline; infra/terraform/main.tf and infra/terraform/azure/main.tf
// for what the chatbot's identity may do to storage. fig-07 shows how the file
// reached storage, and this one starts where that ends. Writes SVG for the
// thesis and a print-resolution PNG beside it into docs/figures/. Colours and
// type follow the other figures there.
const fs = require('node:fs');
const sharp = require('sharp');

const out = 'docs/figures';
const W = 960;
const C = {
  ink:'#16181d', sec:'#3d4350', mut:'#5b6270', warn:'#a13b12',
  cust:'#146b58', custTint:'#e9f3ef', cpTint:'#eef1f6',
  note:'#f7f7f4', noteLine:'#c9c8bf',
};
const esc = s => String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
// A halo is a white-stroked copy drawn underneath, so labels stay legible where
// they cross a line. Not paint-order: Word's SVG renderer may ignore it.
const text = (x, y, s, {size = 14, fill = C.ink, weight, anchor, halo} = {}) => {
  const attrs = `x="${x}" y="${y}" font-size="${size}"${weight ? ` font-weight="${weight}"` : ''}${anchor ? ` text-anchor="${anchor}"` : ''}`;
  return `${halo ? `<text ${attrs} fill="none" stroke="#ffffff" stroke-width="4" stroke-linejoin="round">${esc(s)}</text>` : ''}<text ${attrs} fill="${fill}">${esc(s)}</text>`;
};

// Three columns. The first two meet at the trust boundary, which nothing
// crosses but the reindex call and its reply.
const A = {x:28, w:208};   // control plane
const B = {x:278, w:318};  // chatbot backend, one numbered step per box
const S = {x:660, w:270};  // storage
const BUS = 630;           // where steps 6 and 7 meet on the way to the vector store
const LINE = 15;

const body = [];
const add = s => body.push(s);

function box(col, y, title, lines, {n, stroke = C.sec, dash = false, lineFills = [], minH = 0} = {}){
  const h = Math.max(32 + lines.length * LINE, minH);
  const tx = col.x + (n ? 34 : 12);
  add(`<rect x="${col.x}" y="${y}" width="${col.w}" height="${h}" rx="4" fill="#ffffff" stroke="${stroke}" stroke-width="1.2"${dash ? ' stroke-dasharray="6 4"' : ''}/>`);
  if(n){
    add(`<circle cx="${col.x + 17}" cy="${y + 17}" r="9.5" fill="${C.sec}"/>`);
    add(text(col.x + 17, y + 21.5, String(n), {size:12, weight:'bold', fill:'#ffffff', anchor:'middle'}));
  }
  add(text(tx, y + 22, title, {size:13.5, weight:'bold'}));
  lines.forEach((l, i) => add(text(tx, y + 41 + i * LINE, l, {size:12, fill:lineFills[i] ?? C.mut})));
  return {y, h, bottom:y + h, mid:y + h / 2};
}
function note(col, y, lines){
  const h = 10 + lines.length * LINE;
  add(`<rect x="${col.x}" y="${y}" width="${col.w}" height="${h}" rx="3" fill="${C.note}" stroke="${C.noteLine}" stroke-width="1"/>`);
  lines.forEach((l, i) => add(text(col.x + col.w / 2, y + 17 + i * LINE, l, {size:12.5, fill:C.sec, anchor:'middle'})));
  return {y, h, bottom:y + h};
}
// kind: 'call' solid with a filled head · 'reply' dashed with an open head ·
// 'bytes' thick, in the customer's colour · 'line' no head (feeds the bus)
function arrow(points, kind = 'call'){
  const pts = points.map(p => p.join(',')).join(' ');
  const style = {
    call: `stroke="${C.ink}" stroke-width="1.5" marker-end="url(#f-ink)"`,
    reply: `stroke="${C.ink}" stroke-width="1.5" stroke-dasharray="6 4" marker-end="url(#o-ink)"`,
    bytes: `stroke="${C.cust}" stroke-width="3.2" marker-end="url(#t-cust)"`,
    line: `stroke="${C.ink}" stroke-width="1.5"`,
  }[kind];
  add(`<polyline points="${pts}" fill="none" ${style}/>`);
}
const down = (from, to) => arrow([[B.x + B.w / 2, from.bottom], [B.x + B.w / 2, to.y]]);

// ── triggers ────────────────────────────────────────────────────────────
const TOP = 92;
const a1 = box(A, TOP, 'Upload or delete', [
  'upload: browser reports success,',
  'document row set to uploaded',
  'delete: the signer removes the',
  'object, then the row is dropped',
]);
const resync = note(B, TOP + 10, [
  'Every call is a full resync of the prefix, not',
  'a delta: its cost grows with the number of',
  'documents, not with the size of the change.',
]);

let y = Math.max(a1.bottom, resync.bottom) + 26;
arrow([[A.x + A.w / 2, a1.bottom], [A.x + A.w / 2, y]]);
const a2 = box(A, y, 'Trigger the reindex', [
  'POST /api/index; waits ≤ 120 s',
  'no credential, no file content',
  'a CloudFront-fronted tenant is',
  'called at its load balancer, as',
  'the CDN gives up after 60 s',
]);

// ── the pipeline, inside the tenant's own container ────────────────────
const b1 = box(B, y, 'Admit', [
  'one resync runs at a time and one may wait;',
  'a further call gets 202 at once, since the',
  'waiting run lists storage later and covers it',
  'tenant, bucket and prefix come from the',
  'container’s env, never from the request',
], {n:1});
arrow([[A.x + A.w, y + 40], [B.x, y + 40]]);

const b2 = box(B, b1.bottom + 22, 'List', [
  'every object under the tenant’s prefix,',
  'every page, not just the first 1000 keys',
], {n:2});
down(b1, b2);

const b3 = box(B, b2.bottom + 22, 'Download and extract text', [
  '.txt decoded as UTF-8',
  '.pdf via PyMuPDF · .docx via python-docx',
  'any other file type is skipped',
], {n:3});
down(b2, b3);

const loopTop = b3.bottom + 22;
const b4 = box(B, loopTop + 32, 'Chunk', [
  '200-word windows, 40 words overlapping',
  'fits the model’s 256-token input limit',
], {n:4});
down(b3, b4);

const b5 = box(B, b4.bottom + 20, 'Embed', [
  'all-MiniLM-L6-v2 on the container’s CPU',
  'one 384-dimension vector per chunk',
  'loaded on first use (~13 s), then cached',
], {n:5});
down(b4, b5);

const b6 = box(B, b5.bottom + 20, 'Upsert', [
  'id {tenant}-{key}-{n} is deterministic, so',
  'a rerun overwrites instead of duplicating',
  'metadata: tenant, source key, chunk text',
], {n:6});
down(b5, b6);

// UML loop fragment around the per-document steps
{
  const x1 = B.x - 10, x2 = B.x + B.w + 10, y2 = b6.bottom + 14, tw = 52;
  add(`<rect x="${x1}" y="${loopTop}" width="${x2 - x1}" height="${y2 - loopTop}" fill="none" stroke="${C.sec}" stroke-width="1.1"/>`);
  add(`<path d="M${x1},${loopTop} h${tw} v12 l-7,7 h-${tw - 7} z" fill="#ffffff" stroke="${C.sec}" stroke-width="1.1"/>`);
  add(text(x1 + 8, loopTop + 14, 'loop', {size:12, weight:'bold', fill:C.sec}));
  // Right-aligned so the guard stays clear of the arrow entering at the centre.
  add(text(x2 - 10, loopTop + 15, '[for each document]', {size:12.5, weight:'bold', fill:C.sec, anchor:'end'}));
}

const b7 = box(B, b6.bottom + 14 + 22, 'Purge', [
  'delete every vector whose source key was',
  'not listed this run — how a deleted',
  'document stops reaching answers',
], {n:7});
down(b6, b7);

const b8 = box(B, b7.bottom + 22, 'Respond', [
  '200 “Data indexed successfully”',
  'storage error: 400 or 502',
  'configuration error: 500',
], {n:8});
down(b7, b8);

// ── back on the control plane ───────────────────────────────────────────
const a3 = box(A, b8.y, 'Operator sees the outcome', [
  '200 or 202: done',
  'error or timeout: a warning —',
  'the upload or delete still',
  'stands, only the index is stale',
]);
arrow([[B.x, b8.y + 40], [A.x + A.w, b8.y + 40]], 'reply');

// The server action holds its request open for the whole resync.
{
  const x = A.x + 22, y1 = a2.bottom, y2 = a3.y, my = (y1 + y2) / 2;
  add(`<line x1="${x}" y1="${y1}" x2="${x}" y2="${y2}" stroke="${C.mut}" stroke-width="1.5" stroke-dasharray="2 4"/>`);
  ['the server action', 'waits on this one', 'call while the', 'resync runs'].forEach((l, i) =>
    add(text(x + 14, my - 22 + i * LINE, l, {size:12, fill:C.mut})));
}

// ── storage ─────────────────────────────────────────────────────────────
box(S, b2.y, 'Document store', [
  'S3 bucket or Blob container, private,',
  'encrypted at rest; the file arrived here',
  'straight from the operator’s browser',
  'the chatbot’s identity may list and read',
  'only — the mirror of the signer, which',
  'may write and delete but never read',
], {stroke:C.cust, minH:b3.bottom - b2.y});
arrow([[B.x + B.w, b2.y + 40], [S.x, b2.y + 40]]);
add(text((B.x + B.w + S.x) / 2, b2.y + 33, 'list', {size:11.5, anchor:'middle', halo:true}));
arrow([[S.x, b3.y + 40], [B.x + B.w, b3.y + 40]], 'bytes');
add(text((B.x + B.w + S.x) / 2, b3.y + 31, 'file bytes', {size:11.5, fill:C.cust, weight:'bold', anchor:'middle', halo:true}));

add(text(S.x, b6.y - 26, 'VECTOR STORE', {size:12.5, weight:'bold', fill:C.sec}));
add(text(S.x, b6.y - 10, 'one of the two, chosen at onboarding', {size:12, fill:C.mut}));
const s2 = box(S, b6.y, 'pgvector · in this account', [
  'managed Postgres on the private network',
  'upsert: insert, or update a matching id',
  'purge: one DELETE of the rows whose',
  'source is not among the listed keys',
], {stroke:C.cust});
const notchY = s2.bottom + 14;
const s3 = box(S, notchY + 18, 'Pinecone · customer’s own index', [
  'a third party: vectors and chunk text',
  'leave the customer’s account',
  'upsert by id, as with pgvector',
  'purge: list ids, fetch their metadata,',
  'delete the stale ones 50 at a time',
], {stroke:C.mut, dash:true, lineFills:[C.warn, C.warn]});

// Steps 6 and 7 write to whichever store the tenant has.
{
  const ins = [b6.y + 40, b7.y + 40], outs = [s2.y + 40, s3.y + 40], all = [...ins, ...outs];
  ins.forEach(v => arrow([[B.x + B.w, v], [BUS, v]], 'line'));
  add(`<line x1="${BUS}" y1="${Math.min(...all)}" x2="${BUS}" y2="${Math.max(...all)}" stroke="${C.ink}" stroke-width="1.5"/>`);
  outs.forEach(v => arrow([[BUS, v], [S.x, v]]));
}

// ── bands (drawn under everything else) ─────────────────────────────────
const bandBottom = b8.bottom + 22;
const R = 944;
const under = [
  `<rect x="16" y="16" width="232" height="${bandBottom - 16}" rx="6" fill="${C.cpTint}" stroke="${C.sec}" stroke-width="1.4"/>`,
  // The customer's band stops short of the Pinecone box, which is not in their account.
  `<path d="M266,16 H${R - 6} Q${R},16 ${R},22 V${notchY} H646 V${bandBottom - 6} Q646,${bandBottom} 640,${bandBottom} H266 Q260,${bandBottom} 260,${bandBottom - 6} V22 Q260,16 266,16 Z" fill="${C.custTint}" stroke="${C.cust}" stroke-width="1.5"/>`,
  text(132, 40, 'CONTROL PLANE', {size:13, weight:'bold', fill:C.sec, anchor:'middle'}),
  text(132, 62, 'Next.js server actions', {size:12, fill:C.mut, anchor:'middle'}),
  text(278, 40, 'CUSTOMER CLOUD ACCOUNT', {size:13, weight:'bold', fill:C.cust}),
  text(B.x + B.w / 2, 66, 'Chatbot backend container', {size:12.5, weight:'bold', fill:C.sec, anchor:'middle'}),
  text(S.x + S.w / 2, 66, 'Storage', {size:12.5, weight:'bold', fill:C.sec, anchor:'middle'}),
];

// ── legend ──────────────────────────────────────────────────────────────
y = Math.max(bandBottom, s3.bottom) + 34;
{
  let lx = 28;
  const item = (draw, label) => {
    draw(lx);
    add(text(lx + 54, y, label, {size:12.5, fill:C.sec}));
    lx += 54 + label.length * 6.6 + 30;
  };
  item(x => arrow([[x, y - 4], [x + 44, y - 4]]), 'call or write');
  item(x => arrow([[x, y - 4], [x + 44, y - 4]], 'bytes'), 'document content');
  item(x => arrow([[x, y - 4], [x + 44, y - 4]], 'reply'), 'reply');
  item(x => add(`<rect x="${x}" y="${y - 13}" width="44" height="18" rx="3" fill="#ffffff" stroke="${C.mut}" stroke-width="1.2" stroke-dasharray="6 4"/>`), 'outside the customer’s account');
}
const H = y + 22;

const marker = (id, color, open) => `<marker id="${id}" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="7" markerHeight="7" orient="auto">${open
  ? `<path d="M1,1 L9.5,5 L1,9" fill="none" stroke="${color}" stroke-width="1.4" stroke-linejoin="round"/>`
  : `<path d="M0,0 L10,5 L0,10 z" fill="${color}"/>`}</marker>`;
// The thick arrow's head is sized in user space; scaled by its stroke it would swamp the label.
const defs = [
  marker('f-ink', C.ink, false),
  marker('o-ink', C.ink, true),
  `<marker id="t-cust" viewBox="0 0 10 10" refX="10" refY="5" markerUnits="userSpaceOnUse" markerWidth="13" markerHeight="13" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="${C.cust}"/></marker>`,
].join('');

const label = 'Document indexing: after an upload or delete, the control plane makes one HTTP call to the tenant’s own chatbot backend, which lists and downloads every document under the prefix, extracts text, chunks and embeds each document on its own CPU, upserts the vectors into pgvector or the customer’s Pinecone index, purges the vectors of documents no longer in storage, and replies. No document content reaches the control plane.';
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(label)}">
  <rect x="0" y="0" width="${W}" height="${H}" fill="#ffffff"/>
  <defs>${defs}</defs>
  <g font-family="Arial, Helvetica, sans-serif">${under.join('')}${body.join('')}</g>
</svg>
`;

(async () => {
  const name = 'fig-27-document-indexing';
  fs.writeFileSync(`${out}/${name}.svg`, svg);
  await sharp(Buffer.from(svg), {density:216}).png().toFile(`${out}/${name}.png`);
  console.log(`Wrote ${out}/${name}.svg and .png (${W}×${H})`);
})();
