/* eslint-disable @typescript-eslint/no-require-imports -- Standalone CommonJS figure script. */
// Thesis figure: the deployment workflow as a UML sequence diagram.
//
//   fig-26-deployment-sequence   onboarding, dispatch, federated sign-in,
//                                Terraform, callbacks and reconciliation
//
//   node scripts/plot-deployment-sequence.cjs
//
// Drawn from the code rather than from data: src/app/tenants/new/actions.ts and
// src/lib/aws.ts (onboarding), src/lib/deploy.ts (dispatch), the two deploy
// workflows, src/app/api/deployments/[id]/{status,secrets,progress} and
// src/lib/reconcile.ts. Writes SVG for the thesis and a print-resolution PNG
// beside it into docs/figures/. Colours and type follow the other figures there.
// AWS-only and Azure-only steps are named in their guards as well as coloured,
// so a grayscale print loses nothing.
const fs = require('node:fs');
const sharp = require('sharp');

const out = 'docs/figures';
const W = 960;
const X = {op:72, cp:225, gh:410, id:585, tf:745, cc:890};
const C = {
  ink:'#16181d', sec:'#3d4350', mut:'#5b6270', life:'#b9bec8', rule:'#9aa0aa',
  aws:'#b4540a', az:'#1f5fae',
  cust:'#146b58', custTint:'#e9f3ef', cpTint:'#eef1f6',
  note:'#f7f7f4', noteLine:'#c9c8bf',
};
const esc = s => String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
// A halo is a white-stroked copy drawn underneath, so labels can cross lifelines
// legibly. Not paint-order: Word's SVG renderer may ignore it and stroke over the text.
const text = (x, y, s, {size = 14, fill = C.ink, weight, anchor, halo} = {}) => {
  const attrs = `x="${x}" y="${y}" font-size="${size}"${weight ? ` font-weight="${weight}"` : ''}${anchor ? ` text-anchor="${anchor}"` : ''}`;
  return `${halo ? `<text ${attrs} fill="none" stroke="#ffffff" stroke-width="4" stroke-linejoin="round">${esc(s)}</text>` : ''}<text ${attrs} fill="${fill}">${esc(s)}</text>`;
};

const body = [];
const add = s => body.push(s);
let y = 0;

// ── messages ────────────────────────────────────────────────────────────
// sync: solid line, filled head · async: solid line, open head · reply: dashed, open head
function msg(from, to, label, {kind = 'sync', color = 'ink', detail, at = 'mid', detailAt, gap = 34} = {}){
  y += gap;
  const x1 = X[from], x2 = X[to], dir = Math.sign(x2 - x1), col = C[color];
  const marker = `${kind === 'sync' ? 'f' : 'o'}-${color}`;
  add(`<line x1="${x1}" y1="${y}" x2="${x2}" y2="${y}" stroke="${col}" stroke-width="1.5"${kind === 'reply' ? ' stroke-dasharray="6 4"' : ''} marker-end="url(#${marker})"/>`);
  const place = a => a === 'mid' ? [(x1 + x2) / 2, 'middle']
    : a === 'near' ? [x1 + dir * 12, dir > 0 ? 'start' : 'end']
    : Array.isArray(a) ? a : [a, 'middle'];
  const [lx, la] = place(at);
  add(text(lx, y - 7, label, {anchor:la, halo:true, fill: color === 'ink' ? C.ink : col}));
  if(detail){
    const [dx, da] = place(detailAt ?? at);
    add(text(dx, y + 16, detail, {size:12, fill:C.mut, anchor:da, halo:true}));
    y += 10;
  }
}
function note(cx, lines, {w, x, gap = 12} = {}){
  y += gap;
  const h = 10 + lines.length * 15, left = x ?? cx - w / 2;
  add(`<rect x="${left}" y="${y}" width="${w}" height="${h}" rx="3" fill="${C.note}" stroke="${C.noteLine}" stroke-width="1"/>`);
  lines.forEach((l, i) => add(text(left + w / 2, y + 17 + i * 15, l, {size:12.5, fill:C.sec, anchor:'middle'})));
  y += h;
}
// UML combined fragment: operator tab, guard, optional divider into operands
const frames = [];
function frameOpen(x1, x2, op, guard, color = 'sec', gap = 18){
  y += gap;
  const f = {x1, x2, y1:y};
  frames.push(f);
  const tw = op.length * 8 + 22;
  add(`<path d="M${x1},${y} h${tw} v12 l-7,7 h-${tw - 7} z" fill="#ffffff" stroke="${C.sec}" stroke-width="1.1"/>`);
  add(text(x1 + 8, y + 14, op, {size:12, weight:'bold', fill:C.sec}));
  add(text(x1 + tw + 8, y + 15, guard, {size:12.5, weight:'bold', fill:C[color]}));
  y += 19;
}
function frameDivide(guard, color, gap = 16){
  const f = frames[frames.length - 1];
  y += gap;
  add(`<line x1="${f.x1}" y1="${y}" x2="${f.x2}" y2="${y}" stroke="${C.sec}" stroke-width="1" stroke-dasharray="5 4"/>`);
  add(text(f.x1 + 8, y + 16, guard, {size:12.5, weight:'bold', fill:C[color]}));
  y += 19;
}
function frameClose(gap = 14){
  const f = frames.pop();
  y += gap;
  add(`<rect x="${f.x1}" y="${f.y1}" width="${f.x2 - f.x1}" height="${y - f.y1}" fill="none" stroke="${C.sec}" stroke-width="1.1"/>`);
}
function phase(n, label, {rule = false, gap = 26} = {}){
  y += gap;
  if(rule){
    add(`<line x1="16" y1="${y - 22}" x2="${W - 16}" y2="${y - 22}" stroke="${C.rule}" stroke-width="1.2" stroke-dasharray="2 4"/>`);
  }
  add(`<circle cx="30" cy="${y - 4}" r="10" fill="${C.sec}"/>`);
  add(text(30, y + 0.5, String(n), {size:12, fill:'#ffffff', weight:'bold', anchor:'middle'}));
  add(text(48, y, label, {size:12.5, weight:'bold', fill:C.sec}));
}

// ── 1 · onboarding ──────────────────────────────────────────────────────
y = 66;
phase(1, "ONBOARDING  ·  synchronous, inside the operator's request", {gap:28});
msg('op', 'cp', 'Submit onboarding wizard', {detail:'validated; slug and identity re-checked', gap:30});

frameOpen(100, 945, 'alt', '[AWS]  secrets placed before any workflow exists', 'aws');
msg('cp', 'id', 'AssumeRole  chatbot-client-onboard-{slug}', {color:'aws', at:'near', detail:'sts:ExternalId = tenant id  ·  returns 15-minute credentials', gap:30});
msg('cp', 'cc', 'CreateSecret / UpdateSecret  {slug}/*', {color:'aws', at:'near', detail:'write-only: LLM key, Pinecone key, signer secret', gap:30});
msg('cc', 'cp', 'secret ARNs (kept for the dispatch)', {kind:'reply', color:'aws', gap:30});
frameDivide('[Azure]', 'az', 12);
note(X.cp, ['Encrypt keys in Neon (AES-256-GCM)  ·  no cloud call'], {w:360, x:188, gap:2});
frameClose(10);

note(X.cp, ['INSERT tenant + deployment (pending)'], {w:260});
msg('cp', 'gh', 'workflow_dispatch', {kind:'async', detail:'non-secret inputs  ·  run name carries deployment id', detailAt:[237, 'start'], gap:32});
msg('gh', 'cp', '204  ·  no run id returned', {kind:'reply', detail:'deployment row → running', gap:30});
msg('cp', 'op', 'returns; page polls progress', {kind:'reply', gap:30});

// ── 2 · pipeline ────────────────────────────────────────────────────────
phase(2, 'PIPELINE  ·  asynchronous, after the request has ended', {rule:true, gap:40});
msg('gh', 'cp', 'POST /status  running + run id', {kind:'async', detail:'authenticated by x-webhook-secret', gap:30});

frameOpen(160, 515, 'opt', '[Azure]  no vault exists yet', 'az');
msg('gh', 'cp', 'POST /secrets  (OIDC bearer token)', {color:'az', at:335, detail:'checks signature, repo, sub, workflow_ref, unclaimed', gap:30});
msg('cp', 'gh', 'secret values, released once', {kind:'reply', color:'az', at:335, gap:30});
frameClose(10);

frameOpen(345, 945, 'alt', '[AWS]  deployment authorization', 'aws');
const authTop = y;
msg('gh', 'id', 'AssumeRoleWithWebIdentity', {color:'aws', detail:'→ chatbot-client-deploy-{slug}', gap:30});
msg('id', 'gh', '1-hour credentials', {kind:'reply', color:'aws', gap:30});
frameDivide('[Azure]', 'az', 12);
msg('gh', 'id', 'federated token exchange', {color:'az', detail:'→ chatbot-deploy-{slug}', gap:28});
msg('id', 'gh', 'Entra token, never stored', {kind:'reply', color:'az', gap:30});
frameClose(10);
{
  // Rule that applies to both operands, beside them rather than inside one.
  const ny = authTop + 6, lines = ['Both trust one OIDC subject only:', 'repo:{owner}/{repo}:', 'environment:tenant-{id}', 'Any other run is refused.'];
  add(`<rect x="690" y="${ny}" width="248" height="${10 + lines.length * 15}" rx="3" fill="${C.note}" stroke="${C.noteLine}" stroke-width="1"/>`);
  lines.forEach((l, i) => add(text(814, ny + 17 + i * 15, l, {size:12.5, fill:C.sec, anchor:'middle'})));
}

msg('gh', 'cc', 'Push golden images to ECR / ACR', {at:'near', detail:'copied from the platform ECR (separate platform role)', gap:32});
msg('gh', 'tf', 'terraform init + apply', {detail:"state in the customer's own bucket / storage account", gap:30});
msg('tf', 'cc', 'create / update resources', {detail:'Azure: bootstrap apply, 90 s wait, full apply', detailAt:[948, 'end'], gap:30});
msg('tf', 'gh', 'outputs: chatbot URL, signer URL', {kind:'reply', gap:30});
note(X.gh, ['upload outputs artifact (kept 90 days)', 'Azure: deploy signer code, wipe secrets'], {w:280});
msg('gh', 'cp', 'POST /status  succeeded | failed + outputs', {kind:'async', detail:'x-webhook-secret', gap:30});
note(X.cp, ['accepted only while still active, else 409', 'signer URL checked → UPDATE deployment, tenant'], {w:320, x:95});

// ── polling and reconciliation ─────────────────────────────────────────
frameOpen(22, 520, 'loop', '[every few seconds while active · runs alongside 2]', 'sec', 22);
msg('op', 'cp', 'GET /progress', {gap:30});
msg('cp', 'gh', 'read run status + steps (GitHub API)', {detail:'run found by deployment id if none recorded', gap:30});
frameOpen(115, 510, 'opt', '[run finished, callback lost]', 'sec', 14);
note(X.cp, ['reconcile from run conclusion + outputs artifact'], {w:330, x:150, gap:2});
frameClose(8);
msg('cp', 'op', 'progress, then final state', {kind:'reply', gap:30});
frameClose(12);
const lifeEnd = y + 8;

// ── legend ──────────────────────────────────────────────────────────────
y = lifeEnd + 26;
{
  const items = [['sync', 'call'], ['async', 'asynchronous message'], ['reply', 'reply']];
  let lx = 40;
  for(const [kind, label] of items){
    add(`<line x1="${lx}" y1="${y - 4}" x2="${lx + 44}" y2="${y - 4}" stroke="${C.ink}" stroke-width="1.5"${kind === 'reply' ? ' stroke-dasharray="6 4"' : ''} marker-end="url(#${kind === 'sync' ? 'f' : 'o'}-ink)"/>`);
    add(text(lx + 54, y, label, {size:12.5, fill:C.sec}));
    lx += 54 + label.length * 7 + 34;
  }
  add(`<line x1="${lx}" y1="${y - 4}" x2="${lx + 30}" y2="${y - 4}" stroke="${C.aws}" stroke-width="2.5"/>`);
  add(text(lx + 38, y, 'AWS only', {size:12.5, fill:C.sec}));
  lx += 38 + 60 + 26;
  add(`<line x1="${lx}" y1="${y - 4}" x2="${lx + 30}" y2="${y - 4}" stroke="${C.az}" stroke-width="2.5"/>`);
  add(text(lx + 38, y, 'Azure only', {size:12.5, fill:C.sec}));
}
const H = y + 22;

// ── lifeline heads (drawn under everything else) ────────────────────────
const heads = [
  ['op', 'Operator', 'browser', 110, '#ffffff', C.sec],
  ['cp', 'Control plane', 'Next.js + Neon', 150, C.cpTint, C.sec],
  ['gh', 'GitHub Actions', 'env tenant-{id}', 150, '#ffffff', C.sec],
  ['id', 'Cloud identity', 'AWS STS · Entra ID', 140, C.custTint, C.cust],
  ['tf', 'Terraform', 'on the runner', 120, '#ffffff', C.sec],
  ['cc', 'Customer cloud', 'AWS or Azure', 130, C.custTint, C.cust],
];
const under = [];
for(const [k, title, sub, w, fill, stroke] of heads){
  const x = X[k];
  under.push(`<line x1="${x}" y1="66" x2="${x}" y2="${lifeEnd}" stroke="${C.life}" stroke-width="1" stroke-dasharray="3 4"/>`);
  under.push(`<rect x="${x - w / 2}" y="16" width="${w}" height="50" rx="4" fill="${fill}" stroke="${stroke}" stroke-width="1.2"/>`);
  under.push(text(x, 37, title, {size:14, weight:'bold', anchor:'middle'}));
  under.push(text(x, 55, sub, {size:11.5, fill:C.mut, anchor:'middle'}));
}

const marker = (id, color, open) => `<marker id="${id}" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="7" markerHeight="7" orient="auto">${open
  ? `<path d="M1,1 L9.5,5 L1,9" fill="none" stroke="${color}" stroke-width="1.4" stroke-linejoin="round"/>`
  : `<path d="M0,0 L10,5 L0,10 z" fill="${color}"/>`}</marker>`;
const defs = ['ink', 'aws', 'az'].flatMap(k => [marker(`f-${k}`, C[k], false), marker(`o-${k}`, C[k], true)]).join('');

const label = 'Sequence diagram of a tenant deployment: AWS onboarding places secrets through a write-only role the platform assumes with an ExternalId; the workflow is dispatched and the request ends; GitHub Actions then signs in through OIDC to a separate deployment identity, runs Terraform, and reports back by callback, with polling and reconciliation covering a lost callback.';
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(label)}">
  <rect x="0" y="0" width="${W}" height="${H}" fill="#ffffff"/>
  <defs>${defs}</defs>
  <g font-family="Arial, Helvetica, sans-serif">${under.join('')}${body.join('')}</g>
</svg>
`;

(async () => {
  const name = 'fig-26-deployment-sequence';
  fs.writeFileSync(`${out}/${name}.svg`, svg);
  await sharp(Buffer.from(svg), {density:216}).png().toFile(`${out}/${name}.png`);
  console.log(`Wrote ${out}/${name}.svg and .png (${W}×${H})`);
})();
