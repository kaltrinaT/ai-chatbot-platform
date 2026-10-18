/* eslint-disable @typescript-eslint/no-require-imports -- Standalone CommonJS figure script. */
// Thesis figure: document upload, deletion and indexing as a UML sequence
// diagram, numbered to match the chapter's steps.
//
//   fig-29-document-upload-sequence   presign through the tenant's signer,
//                                     the direct upload, confirmation, the
//                                     explicit reindex call and the resync
//
//   node scripts/plot-document-upload-sequence.cjs
//
// Drawn from the code: src/app/tenants/[id]/documents/{actions.ts,
// UploadDocumentForm.tsx}, src/lib/docsSigner.ts and src/lib/reindex.ts on the
// platform; infra/lambda/docs-signer/index.mjs and infra/azure-functions/
// docs-signer for the signer; main.py, s3_loader.py, rag_service.py and
// vector_store.py in ai-chatbot/ai-backend for the resync. Nothing in storage
// starts indexing (no bucket notification or Event Grid subscription exists;
// SECURITY.md Known Limitation #10 lists that as planned), so the figure shows
// the control plane making the call. Writes SVG and a print-resolution PNG
// into docs/figures/, in the colours and type of fig-26.
const fs = require('node:fs');
const sharp = require('sharp');

const out = 'docs/figures';
const W = 960;
const X = {op:80, cp:228, sg:392, st:552, cb:716, vs:878};
const C = {
  ink:'#16181d', sec:'#3d4350', mut:'#5b6270', life:'#b9bec8', warn:'#a13b12',
  aws:'#b4540a', az:'#1f5fae',
  cust:'#146b58', custTint:'#e9f3ef', cpTint:'#eef1f6',
  note:'#f7f7f4', noteLine:'#c9c8bf',
};
const esc = s => String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
// A halo is a white-stroked copy drawn underneath, so labels can cross lifelines
// legibly. Not paint-order: Word's SVG renderer may ignore it and stroke over the text.
const text = (x, y, s, {size = 13, fill = C.ink, weight, anchor, halo} = {}) => {
  const attrs = `x="${x}" y="${y}" font-size="${size}"${weight ? ` font-weight="${weight}"` : ''}${anchor ? ` text-anchor="${anchor}"` : ''}`;
  return `${halo ? `<text ${attrs} fill="none" stroke="#ffffff" stroke-width="4" stroke-linejoin="round">${esc(s)}</text>` : ''}<text ${attrs} fill="${fill}">${esc(s)}</text>`;
};

const body = [];
const add = s => body.push(s);
let y = 0;

// The chapter's step number, in the left margin beside the message it starts.
function step(n, at){
  add(`<circle cx="22" cy="${at}" r="10" fill="${C.sec}"/>`);
  add(text(22, at + 4, String(n), {size:12, weight:'bold', fill:'#ffffff', anchor:'middle'}));
}

// ── messages ────────────────────────────────────────────────────────────
// call: solid, filled head · reply: dashed, open head · bytes: thick, the
// customer's colour (document content)
function msg(from, to, label, {kind = 'call', detail, at = 'mid', detailAt, gap = 26, n, fill} = {}){
  y += gap;
  const x1 = X[from], x2 = X[to], dir = Math.sign(x2 - x1);
  const style = {
    call: `stroke="${C.ink}" stroke-width="1.5" marker-end="url(#f-ink)"`,
    reply: `stroke="${C.ink}" stroke-width="1.5" stroke-dasharray="6 4" marker-end="url(#o-ink)"`,
    bytes: `stroke="${C.cust}" stroke-width="3.2" marker-end="url(#t-cust)"`,
  }[kind];
  add(`<line x1="${x1}" y1="${y}" x2="${x2}" y2="${y}" ${style}/>`);
  const place = a => a === 'mid' ? [(x1 + x2) / 2, 'middle']
    : a === 'near' ? [x1 + dir * 12, dir > 0 ? 'start' : 'end']
    : Array.isArray(a) ? a : [a, 'middle'];
  const [lx, la] = place(at);
  add(text(lx, y - 7, label, {anchor:la, halo:true, fill:fill ?? (kind === 'bytes' ? C.cust : C.ink), weight:kind === 'bytes' ? 'bold' : undefined}));
  if(n) step(n, y);
  // A detail may run to more than one line; each adds to the row's height.
  const details = detail === undefined ? [] : [].concat(detail);
  const [dx, da] = place(detailAt ?? at);
  details.forEach((d, i) => add(text(dx, y + 16 + i * 14, d, {size:11.5, fill:C.mut, anchor:da, halo:true})));
  if(details.length) y += 10 + (details.length - 1) * 14;
  return y;
}
function note(cx, lines, {w, x, gap = 12, n} = {}){
  y += gap;
  const h = 10 + lines.length * 15, left = x ?? cx - w / 2;
  add(`<rect x="${left}" y="${y}" width="${w}" height="${h}" rx="3" fill="${C.note}" stroke="${C.noteLine}" stroke-width="1"/>`);
  lines.forEach((l, i) => add(text(left + w / 2, y + 17 + i * 15, l, {size:12, fill:C.sec, anchor:'middle'})));
  if(n) step(n, y + h / 2);
  y += h;
}
// UML combined fragment: operator tab, guard, optional divider into operands
const frames = [];
function frameOpen(x1, x2, op, guard, gap = 18){
  y += gap;
  frames.push({x1, x2, y1:y});
  const tw = op.length * 8 + 22;
  add(`<path d="M${x1},${y} h${tw} v12 l-7,7 h-${tw - 7} z" fill="#ffffff" stroke="${C.sec}" stroke-width="1.1"/>`);
  add(text(x1 + 8, y + 14, op, {size:12, weight:'bold', fill:C.sec}));
  add(text(x1 + tw + 8, y + 15, guard, {size:12.5, weight:'bold', fill:C.sec}));
  y += 19;
}
function frameDivide(guard, gap = 16){
  const f = frames[frames.length - 1];
  y += gap;
  add(`<line x1="${f.x1}" y1="${y}" x2="${f.x2}" y2="${y}" stroke="${C.sec}" stroke-width="1" stroke-dasharray="5 4"/>`);
  add(text(f.x1 + 8, y + 16, guard, {size:12.5, weight:'bold', fill:C.sec}));
  y += 19;
}
function frameClose(gap = 14){
  const f = frames.pop();
  y += gap;
  add(`<rect x="${f.x1}" y="${f.y1}" width="${f.x2 - f.x1}" height="${y - f.y1}" fill="none" stroke="${C.sec}" stroke-width="1.1"/>`);
}

// ── upload, or delete ───────────────────────────────────────────────────
y = 104;
frameOpen(40, 640, 'alt', '[upload a document]', 0);
msg('op', 'cp', 'request upload URL', {detail:['name, type, size;', 'session must own the tenant'], n:1, at:'near', detailAt:'near'});
msg('cp', 'sg', 'POST presign-upload', {detail:'x-docs-signer-secret header', n:2, gap:30});
note(X.sg, ['signer mints the key; AWS: presigned POST,', 'Azure: user-delegation SAS; valid 60 s'], {w:290, gap:10, n:3});
msg('sg', 'cp', 'object key, URL (+ form fields)', {kind:'reply', gap:28});
msg('cp', 'op', 'URL (+ fields), document id', {kind:'reply', detail:'row inserted as pending', detailAt:[X.cp - 12, 'end'], gap:28});
const bytesY = msg('op', 'st', 'file bytes, straight to storage', {kind:'bytes', detail:'POST multipart (AWS) · PUT block blob (Azure)', n:4, gap:30});
msg('st', 'op', '2xx', {kind:'reply', at:'near', gap:24});

frameOpen(52, 330, 'opt', '[upload failed]', 12);
msg('op', 'cp', 'abandon upload', {at:'near', detail:'pending row deleted; no reindex', detailAt:'near', gap:24});
frameClose(10);

msg('op', 'cp', 'confirm upload', {detail:['document id; row → uploaded,', 'on the browser’s report alone'], at:'near', detailAt:'near', n:5, gap:28});

frameDivide('[delete a document]', 14);
msg('op', 'cp', 'delete document', {at:'near', gap:26, n:1});
msg('cp', 'sg', 'POST delete', {detail:'object key, same header', gap:26, n:2});
msg('sg', 'st', 'delete object', {detail:'as the signer’s own identity', gap:26});
msg('sg', 'cp', 'ok; the row is then deleted', {kind:'reply', n:5, gap:30});
frameClose(12);

// Beside the upload rather than below it: the point is what does not happen
// at the moment the file lands.
{
  const lines = ['Storage raises no event when the file', 'lands. Indexing starts only when the', 'control plane calls it (step 6).'];
  const nx = 660, nw = 270, ny = bytesY - 18, nh = 10 + lines.length * 15;
  add(`<rect x="${nx}" y="${ny}" width="${nw}" height="${nh}" rx="3" fill="${C.note}" stroke="${C.noteLine}" stroke-width="1"/>`);
  lines.forEach((l, i) => add(text(nx + nw / 2, ny + 17 + i * 15, l, {size:12, fill:C.sec, anchor:'middle'})));
}

// ── indexing, after either branch ───────────────────────────────────────
msg('cp', 'cb', 'POST /api/index', {detail:['public, no credential (limitation 10); waits ≤ 120 s', 'one resync at a time; a call while one waits gets 202'], n:6, gap:32});
msg('cb', 'st', 'list every object under the prefix', {gap:28, n:7});

frameOpen(470, 790, 'loop', '[each object]', 12);
msg('cb', 'st', 'get object', {gap:24});
msg('st', 'cb', 'file bytes → text', {kind:'bytes', detail:'.txt · .pdf · .docx; others skipped', gap:26});
frameClose(10);

frameOpen(470, 944, 'loop', '[each document]', 12);
msg('cb', 'vs', 'upsert vectors', {detail:['chunked (200 words, 40 overlap), 384', 'values each, id {tenant}-{key}-{n}'], gap:28});
frameClose(10);

msg('cb', 'vs', 'purge vectors of unlisted keys', {gap:30});
msg('cb', 'cp', '200 · 202 · error', {kind:'reply', gap:28});
msg('cp', 'op', 'done, or “… but reindexing failed”', {kind:'reply', detail:'the upload or delete itself stands', gap:28});
const lifeEnd = y + 14;

// ── legend ──────────────────────────────────────────────────────────────
y = lifeEnd + 30;
{
  let lx = 40;
  const item = (draw, label) => {
    draw(lx);
    add(text(lx + 54, y, label, {size:12.5, fill:C.sec}));
    lx += 54 + label.length * 6.6 + 30;
  };
  const seg = kind => x => {
    const style = {
      call: `stroke="${C.ink}" stroke-width="1.5" marker-end="url(#f-ink)"`,
      reply: `stroke="${C.ink}" stroke-width="1.5" stroke-dasharray="6 4" marker-end="url(#o-ink)"`,
      bytes: `stroke="${C.cust}" stroke-width="3.2" marker-end="url(#t-cust)"`,
    }[kind];
    add(`<line x1="${x}" y1="${y - 4}" x2="${x + 44}" y2="${y - 4}" ${style}/>`);
  };
  item(seg('call'), 'call');
  item(seg('reply'), 'reply');
  item(seg('bytes'), 'document content');
  item(x => {
    add(`<circle cx="${x + 22}" cy="${y - 4}" r="10" fill="${C.sec}"/>`);
    add(text(x + 22, y, 'n', {size:12, weight:'bold', fill:'#ffffff', anchor:'middle'}));
  }, 'step in the text');
}
const H = y + 22;

// ── lifeline heads (drawn under everything else) ────────────────────────
const heads = [
  ['op', 'Operator', 'browser', 116, '#ffffff', C.sec],
  ['cp', 'Control plane', 'Next.js + Neon', 132, C.cpTint, C.sec],
  ['sg', 'Docs signer', 'writes, never reads', 136, C.custTint, C.cust],
  ['st', 'Document store', 'S3 or Blob', 136, C.custTint, C.cust],
  ['cb', 'Chatbot backend', 'FastAPI container', 140, C.custTint, C.cust],
  ['vs', 'Vector store', 'pgvector or Pinecone', 128, C.custTint, C.cust],
];
const under = [];
{
  // Bracket naming the customer's account over the four lifelines inside it.
  const x1 = X.sg - 68, x2 = X.vs + 64;
  under.push(`<path d="M${x1},${40} V${32} H${x2} V${40}" fill="none" stroke="${C.cust}" stroke-width="1.4"/>`);
  under.push(text((x1 + x2) / 2, 24, 'CUSTOMER CLOUD ACCOUNT', {size:12.5, weight:'bold', fill:C.cust, anchor:'middle'}));
}
for(const [k, title, sub, w, fill, stroke] of heads){
  const x = X[k];
  under.push(`<line x1="${x}" y1="96" x2="${x}" y2="${lifeEnd}" stroke="${C.life}" stroke-width="1" stroke-dasharray="3 4"/>`);
  under.push(`<rect x="${x - w / 2}" y="46" width="${w}" height="50" rx="4" fill="${fill}" stroke="${stroke}" stroke-width="1.2"/>`);
  under.push(text(x, 67, title, {size:14, weight:'bold', anchor:'middle'}));
  under.push(text(x, 85, sub, {size:11.5, fill:C.mut, anchor:'middle'}));
}

const marker = (id, color, open) => `<marker id="${id}" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="7" markerHeight="7" orient="auto">${open
  ? `<path d="M1,1 L9.5,5 L1,9" fill="none" stroke="${color}" stroke-width="1.4" stroke-linejoin="round"/>`
  : `<path d="M0,0 L10,5 L0,10 z" fill="${color}"/>`}</marker>`;
// The thick arrow's head is sized in user space; scaled by its stroke it would swamp the label.
const defs = [
  marker('f-ink', C.ink, false),
  marker('o-ink', C.ink, true),
  `<marker id="t-cust" viewBox="0 0 10 10" refX="10" refY="5" markerUnits="userSpaceOnUse" markerWidth="13" markerHeight="13" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="${C.cust}"/></marker>`,
].join('');

const label = 'Sequence diagram of document upload and indexing. The control plane asks the tenant’s docs signer for a 60-second upload authorization, a presigned POST on AWS or a user-delegation SAS on Azure, records the document as pending, and the browser uploads the file straight to storage, then confirms. A delete goes through the signer, which removes the object itself. Either way the control plane then calls the backend’s public /api/index, which re-reads every object, chunks, embeds and upserts each document, and purges vectors of removed ones. Storage triggers nothing.';
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(label)}">
  <rect x="0" y="0" width="${W}" height="${H}" fill="#ffffff"/>
  <defs>${defs}</defs>
  <g font-family="Arial, Helvetica, sans-serif">${under.join('')}${body.join('')}</g>
</svg>
`;

(async () => {
  const name = 'fig-29-document-upload-sequence';
  fs.writeFileSync(`${out}/${name}.svg`, svg);
  await sharp(Buffer.from(svg), {density:216}).png().toFile(`${out}/${name}.png`);
  console.log(`Wrote ${out}/${name}.svg and .png (${W}×${H})`);
})();
