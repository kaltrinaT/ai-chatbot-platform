/* eslint-disable @typescript-eslint/no-require-imports -- Standalone CommonJS figure script. */
// Thesis figure: document indexing as a left-to-right pipeline, with one
// document traced through it underneath.
//
//   fig-27-document-indexing-pipeline   the same six steps as fig-27, laid out
//                                       like fig-08 (the query side of RAG)
//
//   node scripts/plot-document-indexing-pipeline.cjs
//
// Sources as for scripts/plot-document-indexing.cjs: the platform's
// documents/actions.ts and lib/reindex.ts, and main.py, s3_loader.py,
// rag_service.py and vector_store.py in ai-chatbot/ai-backend. The worked
// example is illustrative, but its arithmetic is the code's: chunk_text starts
// a 200-word window every 160 words, so 1,000 words give seven chunks, the
// last holding only words 961-1000. The vector shading is decoration, not
// data. Writes SVG and a print-resolution PNG into docs/figures/.
const fs = require('node:fs');
const sharp = require('sharp');

const out = 'docs/figures';
const W = 960;
const C = {
  ink:'#16181d', sec:'#3d4350', mut:'#5b6270', warn:'#a13b12', faint:'#9aa0aa', life:'#b9bec8',
  cust:'#146b58', custTint:'#e9f3ef', cpTint:'#eef1f6',
  note:'#f7f7f4', noteLine:'#c9c8bf',
};
const esc = s => String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
// A halo is a white-stroked copy drawn underneath, so labels stay legible where
// they cross a line. Not paint-order: Word's SVG renderer may ignore it.
const text = (x, y, s, {size = 14, fill = C.ink, weight, anchor, halo, family} = {}) => {
  const attrs = `x="${x}" y="${y}" font-size="${size}"${weight ? ` font-weight="${weight}"` : ''}${anchor ? ` text-anchor="${anchor}"` : ''}${family ? ` font-family="${family}"` : ''}`;
  return `${halo ? `<text ${attrs} fill="none" stroke="#ffffff" stroke-width="4" stroke-linejoin="round">${esc(s)}</text>` : ''}<text ${attrs} fill="${fill}">${esc(s)}</text>`;
};
const MONO = "Consolas, 'Courier New', monospace";

const body = [];
const add = s => body.push(s);
const LINE = 14;

function box(x, y, w, h, title, lines, {n, stroke = C.sec, dash = false, lineFills = []} = {}){
  add(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="4" fill="#ffffff" stroke="${stroke}" stroke-width="1.2"${dash ? ' stroke-dasharray="6 4"' : ''}/>`);
  const tx = x + (n ? 32 : 12);
  if(n){
    add(`<circle cx="${x + 16}" cy="${y + 15.5}" r="9" fill="${C.sec}"/>`);
    add(text(x + 16, y + 20, String(n), {size:12, weight:'bold', fill:'#ffffff', anchor:'middle'}));
  }
  if(title) add(text(tx, y + 20, title, {size:13.5, weight:'bold'}));
  lines.forEach((l, i) => add(text(n ? x + 12 : tx, y + 38 + i * LINE, l, {size:12, fill:lineFills[i] ?? C.mut})));
}
// kind: 'call' solid with a filled head · 'reply' dashed with an open head ·
// 'bytes' thick, in the customer's colour
function arrow(points, kind = 'call'){
  const pts = points.map(p => p.join(',')).join(' ');
  const style = {
    call: `stroke="${C.ink}" stroke-width="1.5" marker-end="url(#f-ink)"`,
    reply: `stroke="${C.ink}" stroke-width="1.5" stroke-dasharray="6 4" marker-end="url(#o-ink)"`,
    bytes: `stroke="${C.cust}" stroke-width="3.2" marker-end="url(#t-cust)"`,
  }[kind];
  add(`<polyline points="${pts}" fill="none" ${style}/>`);
}

// ── control plane strip ─────────────────────────────────────────────────
const CP = {top:16, bottom:116};
const T = {x:24, y:46, w:300, h:58};
const O = {x:636, y:46, w:300, h:58};
box(T.x, T.y, T.w, T.h, 'Upload or delete confirmed', [
  'POST /api/index, waits ≤ 120 s',
  'no credential and no file content',
]);
box(O.x, O.y, O.w, O.h, 'Operator sees the outcome', [
  '200 or 202: done',
  'error or timeout: a stale-index warning',
]);
add(`<line x1="${T.x + T.w}" y1="${T.y + 30}" x2="${O.x}" y2="${T.y + 30}" stroke="${C.mut}" stroke-width="1.5" stroke-dasharray="2 4"/>`);
add(text((T.x + T.w + O.x) / 2, T.y + 23, 'request held open while the resync runs', {size:12, fill:C.mut, anchor:'middle'}));

// ── the six steps ───────────────────────────────────────────────────────
const COL = i => 22 + 156 * i;
const CW = 136;
const mid = i => COL(i) + CW / 2;
const ROW = {y:190, h:86};
const steps = [
  ['Load', ['list every object', 'under the prefix,', 'download each one']],
  ['Extract', ['.txt: UTF-8', '.pdf: PyMuPDF', '.docx: python-docx', 'others skipped']],
  ['Chunk', ['200-word windows', 'starting every 160', 'words: 40 overlap']],
  ['Embed', ['all-MiniLM-L6-v2', 'on the CPU: 384', 'values per chunk']],
  ['Upsert', ['id tenant-key-n:', 'a rerun overwrites', 'stores the text too']],
  ['Purge', ['delete the vectors', 'of files no longer', 'in storage']],
];
steps.forEach(([title, lines], i) => {
  box(COL(i), ROW.y, CW, ROW.h, title, lines, {n:i + 1});
  if(i) arrow([[COL(i - 1) + CW, ROW.y + 43], [COL(i), ROW.y + 43]]);
});
const rowBottom = ROW.y + ROW.h;

// UML loop fragment around the per-document steps 3-5
{
  const x1 = COL(2) - 8, x2 = COL(4) + CW + 8, y1 = ROW.y - 28, y2 = rowBottom + 10, tw = 52;
  add(`<rect x="${x1}" y="${y1}" width="${x2 - x1}" height="${y2 - y1}" fill="none" stroke="${C.sec}" stroke-width="1.1"/>`);
  add(`<path d="M${x1},${y1} h${tw} v12 l-7,7 h-${tw - 7} z" fill="#ffffff" stroke="${C.sec}" stroke-width="1.1"/>`);
  add(text(x1 + 8, y1 + 14, 'loop', {size:12, weight:'bold', fill:C.sec}));
  add(text(x2 - 10, y1 + 15, '[for each document]', {size:12.5, weight:'bold', fill:C.sec, anchor:'end'}));
}

// trigger in, reply out
arrow([[mid(0), T.y + T.h], [mid(0), ROW.y]]);
arrow([[mid(5), ROW.y], [mid(5), O.y + O.h]], 'reply');

// ── storage and notes ───────────────────────────────────────────────────
const STORE_Y = rowBottom + 26;
box(COL(0), STORE_Y, COL(1) + CW - COL(0), 58, 'Document store', [
  'S3 bucket or Blob container, private',
  'the chatbot may list and read, never write',
]);
add(`<rect x="${COL(0)}" y="${STORE_Y}" width="${COL(1) + CW - COL(0)}" height="58" rx="4" fill="none" stroke="${C.cust}" stroke-width="1.2"/>`);
arrow([[COL(0) + 34, rowBottom], [COL(0) + 34, STORE_Y]]);
add(text(COL(0) + 42, rowBottom + 17, 'list', {size:11.5, halo:true}));
arrow([[COL(0) + 104, STORE_Y], [COL(0) + 104, rowBottom]], 'bytes');
add(text(COL(0) + 114, rowBottom + 17, 'file bytes', {size:11.5, weight:'bold', fill:C.cust, halo:true}));

{
  const x = COL(2), w = COL(3) + CW - COL(2), lines = [
    'Every call re-indexes every document under',
    'the prefix: cost grows with document count.',
    'One resync at a time, one more may wait;',
    'any further call is answered 202 at once.',
  ];
  add(`<rect x="${x}" y="${STORE_Y}" width="${w}" height="${10 + lines.length * LINE}" rx="3" fill="${C.note}" stroke="${C.noteLine}" stroke-width="1"/>`);
  lines.forEach((l, i) => add(text(x + w / 2, STORE_Y + 17 + i * LINE, l, {size:12, fill:C.sec, anchor:'middle'})));
}

// The vector store straddles the account's edge: pgvector sits inside it,
// Pinecone outside, so the band's bottom line runs between the two.
const VS = {x:COL(4), w:COL(5) + CW - COL(4), inH:70, outH:46};
const BAND_BOTTOM = STORE_Y + VS.inH;
add(`<rect x="${VS.x}" y="${BAND_BOTTOM}" width="${VS.w}" height="${VS.outH}" rx="4" fill="#ffffff" stroke="${C.mut}" stroke-width="1.2" stroke-dasharray="6 4"/>`);
add(text(VS.x + 12, BAND_BOTTOM + 18, 'or Pinecone, the customer’s own index:', {size:12, fill:C.mut}));
add(text(VS.x + 12, BAND_BOTTOM + 32, 'vectors and chunk text leave the account', {size:12, fill:C.warn}));
add(`<rect x="${VS.x}" y="${STORE_Y}" width="${VS.w}" height="${VS.inH}" rx="4" fill="#ffffff" stroke="${C.cust}" stroke-width="1.2"/>`);
add(text(VS.x + 12, STORE_Y + 20, 'Vector store, chosen at onboarding', {size:13.5, weight:'bold'}));
add(text(VS.x + 12, STORE_Y + 38, 'pgvector: managed Postgres in this', {size:12, fill:C.mut}));
add(text(VS.x + 12, STORE_Y + 52, 'account, on its private network', {size:12, fill:C.mut}));
arrow([[mid(4), rowBottom], [mid(4), STORE_Y]]);
arrow([[mid(5), rowBottom], [mid(5), STORE_Y]]);

// ── worked example ──────────────────────────────────────────────────────
const EX = {top:BAND_BOTTOM + VS.outH + 16};
EX.art = EX.top + 34;            // top of each illustration
EX.cap = EX.art + 80;            // caption baseline
EX.bottom = EX.cap + 40;
const IT = k => 30 + 190 * k;    // item left edge
const IW = 140;
const ic = k => IT(k) + IW / 2;

// 1 · the file, as the operator uploaded it
{
  const x = ic(0) - 22, y = EX.art + 2, w = 44, h = 56, f = 12;
  add(`<path d="M${x},${y} h${w - f} l${f},${f} v${h - f} h-${w} z" fill="#ffffff" stroke="${C.sec}" stroke-width="1.2"/>`);
  add(`<path d="M${x + w - f},${y} v${f} h${f}" fill="none" stroke="${C.sec}" stroke-width="1.2"/>`);
  [0, 1, 2, 3].forEach(i => add(`<line x1="${x + 7}" y1="${y + 20 + i * 7}" x2="${x + w - 7 - (i === 3 ? 12 : 0)}" y2="${y + 20 + i * 7}" stroke="${C.life}" stroke-width="2"/>`));
  add(`<rect x="${x - 8}" y="${y + 40}" width="30" height="13" rx="2" fill="${C.sec}"/>`);
  add(text(x + 7, y + 50, 'PDF', {size:9.5, weight:'bold', fill:'#ffffff', anchor:'middle'}));
}
// 2 · extracted text
[110, 104, 110, 96, 110, 106, 62].forEach((w, i) =>
  add(`<line x1="${ic(1) - 55}" y1="${EX.art + 6 + i * 8.5}" x2="${ic(1) - 55 + w}" y2="${EX.art + 6 + i * 8.5}" stroke="${C.faint}" stroke-width="3.2" stroke-linecap="round"/>`));
// 3 · 200-word windows every 160 words over 1,000 words, at 0.12 px a word
{
  const x0 = ic(2) - 60, k = 0.12;
  add(`<rect x="${x0}" y="${EX.art}" width="${1000 * k}" height="5" fill="${C.life}"/>`);
  for(let i = 0, start = 0; start < 1000; i++, start += 160){
    const end = Math.min(start + 200, 1000);
    add(`<rect x="${x0 + start * k}" y="${EX.art + 9 + i * 7.6}" width="${(end - start) * k}" height="5" fill="${C.cust}"/>`);
  }
}
// 4 · one vector per chunk (shading is decoration)
{
  const shades = ['#d4e9e1', '#a9d3c3', '#6fb39b', '#2f8a6f', C.cust];
  let seed = 7; // fixed, so every run draws the same figure
  const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for(let i = 0; i < 7; i++) for(let j = 0; j < 20; j++){
    add(`<rect x="${ic(3) - 55 + j * 5.5}" y="${EX.art + 3 + i * 8.2}" width="5.5" height="6.2" fill="${shades[Math.floor(rand() * 5)]}"/>`);
  }
}
// 5 · the rows written, keyed so a rerun overwrites them
{
  const x = ic(4) - 68, y = EX.art + 4, w = 136, rh = 13;
  const rows = ['acme-handbook.pdf-0', '…', 'acme-handbook.pdf-6'];
  add(`<rect x="${x}" y="${y}" width="${w}" height="${rh * (rows.length + 1) + 4}" fill="#ffffff" stroke="${C.sec}" stroke-width="1"/>`);
  add(`<rect x="${x}" y="${y}" width="${w}" height="${rh + 2}" fill="${C.custTint}" stroke="${C.sec}" stroke-width="1"/>`);
  add(text(x + 6, y + 11, 'id', {size:10.5, weight:'bold', fill:C.sec}));
  rows.forEach((r, i) => add(text(x + 6, y + rh + 14 + i * rh, r, {size:10.5, fill:C.ink, family:MONO})));
}
// arrows between the illustrations, labelled with the step that does the work
['extract', 'chunk', 'embed', 'upsert'].forEach((word, k) => {
  const x1 = IT(k) + IW + 6, x2 = IT(k + 1) - 6, cx = (x1 + x2) / 2, y = EX.art + 30;
  arrow([[x1, y], [x2, y]]);
  add(`<circle cx="${cx}" cy="${y - 14}" r="8" fill="${C.sec}"/>`);
  add(text(cx, y - 10, String(k + 2), {size:11, weight:'bold', fill:'#ffffff', anchor:'middle'}));
  add(text(cx, y + 16, word, {size:11.5, fill:C.mut, anchor:'middle'}));
});
[
  ['handbook.pdf', 'in the document store'],
  ['plain text', 'about 1,000 words'],
  ['7 chunks', 'the last only 40 words'],
  ['7 vectors', '384 values each'],
  ['7 rows', 'with tenant, source, text'],
].forEach(([cap, sub], k) => {
  add(text(ic(k), EX.cap, cap, {size:12.5, weight:'bold', anchor:'middle'}));
  add(text(ic(k), EX.cap + 15, sub, {size:11.5, fill:C.mut, anchor:'middle'}));
});
add(text(W / 2, EX.bottom - 6, 'If handbook.pdf is later deleted, step 6 of the next run removes all seven rows.', {size:12, fill:C.sec, anchor:'middle'}));

// ── bands and panel (drawn under everything else) ───────────────────────
const under = [
  `<rect x="16" y="${CP.top}" width="928" height="${CP.bottom - CP.top}" rx="6" fill="${C.cpTint}" stroke="${C.sec}" stroke-width="1.4"/>`,
  text(28, 36, 'CONTROL PLANE', {size:13, weight:'bold', fill:C.sec}),
  text(156, 36, 'Next.js server actions', {size:12, fill:C.mut}),
  `<rect x="16" y="128" width="928" height="${BAND_BOTTOM - 128}" rx="6" fill="${C.custTint}" stroke="${C.cust}" stroke-width="1.5"/>`,
  text(110, 150, 'CUSTOMER CLOUD ACCOUNT', {size:13, weight:'bold', fill:C.cust}),
  text(318, 150, 'the tenant’s own chatbot backend and storage', {size:12, fill:C.mut}),
  `<rect x="16" y="${EX.top}" width="928" height="${EX.bottom - EX.top}" rx="6" fill="${C.note}" stroke="${C.noteLine}" stroke-width="1"/>`,
  text(28, EX.top + 20, 'ONE DOCUMENT THROUGH THE PIPELINE', {size:13, weight:'bold', fill:C.sec}),
  text(304, EX.top + 20, 'illustrative: a 1,000-word PDF uploaded to tenant “acme”', {size:12, fill:C.mut}),
];

// ── legend ──────────────────────────────────────────────────────────────
let y = EX.bottom + 26;
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
const H = y + 18;

const marker = (id, color, open) => `<marker id="${id}" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="7" markerHeight="7" orient="auto">${open
  ? `<path d="M1,1 L9.5,5 L1,9" fill="none" stroke="${color}" stroke-width="1.4" stroke-linejoin="round"/>`
  : `<path d="M0,0 L10,5 L0,10 z" fill="${color}"/>`}</marker>`;
// The thick arrow's head is sized in user space; scaled by its stroke it would swamp the label.
const defs = [
  marker('f-ink', C.ink, false),
  marker('o-ink', C.ink, true),
  `<marker id="t-cust" viewBox="0 0 10 10" refX="10" refY="5" markerUnits="userSpaceOnUse" markerWidth="13" markerHeight="13" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="${C.cust}"/></marker>`,
].join('');

const label = 'Document indexing as a pipeline. After an upload or delete the control plane makes one HTTP call to the tenant’s chatbot backend, which loads every document under the prefix, extracts text, splits it into overlapping 200-word chunks, embeds each chunk as 384 values, upserts the vectors into the vector store and purges those of deleted files. Beneath, one 1,000-word PDF becomes seven chunks, seven vectors and seven rows.';
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(label)}">
  <rect x="0" y="0" width="${W}" height="${H}" fill="#ffffff"/>
  <defs>${defs}</defs>
  <g font-family="Arial, Helvetica, sans-serif">${under.join('')}${body.join('')}</g>
</svg>
`;

(async () => {
  const name = 'fig-27-document-indexing-pipeline';
  fs.writeFileSync(`${out}/${name}.svg`, svg);
  await sharp(Buffer.from(svg), {density:216}).png().toFile(`${out}/${name}.png`);
  console.log(`Wrote ${out}/${name}.svg and .png (${W}×${H})`);
})();
