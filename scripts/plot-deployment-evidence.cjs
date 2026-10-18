/* eslint-disable @typescript-eslint/no-require-imports -- Standalone CommonJS evaluation script. */
// Thesis figures for the deployment evidence, drawn from the archived run history:
//
//   fig-28-deployment-timeline   every step of each successful deployment, in time order
//   fig-29-attempt-progress      how far each deployment attempt of the evaluated version got
//
//   node scripts/plot-deployment-evidence.cjs
//
// Reads docs/evaluation/oidc/history.json (written by evaluate-oidc-deployments.cjs)
// and, for fig-29, the commits between consecutive attempts from git. Writes SVG
// for the thesis and a print-resolution PNG beside it into docs/figures/. Colours
// and type follow the other figures there: AWS blue and Azure orange, as in
// fig-15 to fig-18, and the pass/fail styles of fig-24. Every step name is mapped
// explicitly, so a workflow step this script has never seen stops it rather than
// landing in the wrong phase.
const fs = require('node:fs');
const {execFileSync} = require('node:child_process');
const sharp = require('sharp');

const out = 'docs/figures';
const history = JSON.parse(fs.readFileSync('docs/evaluation/oidc/history.json','utf8'));

const ink = {primary:'#16181d', secondary:'#3d4350', muted:'#5b6270', faint:'#898781', rule:'#e1e0d9', axis:'#c3c2b7', band:'#f3f2ee'};
const cloud = {aws:{label:'AWS', fill:'#2a78d6'}, azure:{label:'Azure', fill:'#eb6834'}};
const good = {solid:'#146b58', tint:'#e9f3ef'}, bad = {solid:'#a13b12', tint:'#f8ebe5'};
const esc = s => String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const text = (x, y, s, {size = 12, fill = ink.primary, weight, anchor, style} = {}) => `<text x="${x}" y="${y}" font-size="${size}" fill="${fill}"${weight ? ` font-weight="${weight}"` : ''}${anchor ? ` text-anchor="${anchor}"` : ''}${style ? ` font-style="${style}"` : ''}>${esc(s)}</text>`;
// Approximate Arial advance widths, in ems, so a label is only placed where it
// fits. Erring wide: a label judged to fit really does.
function textWidth(s, size, bold = false){
  let em = 0;
  for(const ch of String(s)) em += /[A-Z]/.test(ch) ? 0.68 : /[0-9]/.test(ch) ? 0.56 : /[ijlft]/.test(ch) ? 0.3 : /[mw]/.test(ch) ? 0.84 : /[a-z]/.test(ch) ? 0.54 : ch === ' ' ? 0.28 : 0.4;
  return em * size * (bold ? 1.08 : 1);
}
function wrap(s, max){ const lines = []; let line = ''; for(const word of String(s).split(' ')){ if(line && (line + ' ' + word).length > max){ lines.push(line); line = word; } else line = line ? `${line} ${word}` : word; } if(line) lines.push(line); return lines; }
const seconds = (from, to) => (Date.parse(to) - Date.parse(from)) / 1000;
function duration(s){ s = Math.round(s); if(s < 60) return `${s} s`; const m = Math.floor(s / 60), r = s % 60; return r ? `${m} min ${r} s` : `${m} min`; }
const percent = f => f > 0 && f < 0.005 ? '<1%' : `${Math.round(f * 100)}%`;
const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const day = iso => { const d = new Date(iso); return `${d.getUTCDate()} ${months[d.getUTCMonth()]}`; };
const clock = iso => new Date(iso).toISOString().slice(11, 16);
const swatch = (x, y, fill, size = 12) => `<rect x="${x}" y="${y}" width="${size}" height="${size}" rx="2" fill="${fill}"/>`;
const steps = run => run.jobs.flatMap(job => job.steps).sort((a, b) => a.number - b.number);

function svg(width, height, label, body){
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="${esc(label)}">\n  <rect x="0" y="0" width="${width}" height="${height}" fill="#ffffff"/>\n  <g font-family="Arial, Helvetica, sans-serif">${body}</g>\n</svg>\n`;
}
async function save(name, content){
  fs.writeFileSync(`${out}/${name}.svg`, content);
  await sharp(Buffer.from(content), {density:216}).png().toFile(`${out}/${name}.png`);
  console.log(`Wrote ${out}/${name}.svg and .png`);
}

const deploys = history.candidates.filter(c => c.kind === 'deploy');
// The commit the evaluated implementation starts from, as evaluate-oidc-deployments.cjs
// was given it; earlier runs were never extracted into candidates.
const version = history.from_commit ? `commit ${history.from_commit.slice(0, 7)}` : 'the evaluated version';
const byCloudThenTime = (a, b) => a.cloud_provider === b.cloud_provider ? Date.parse(a.started_at) - Date.parse(b.started_at) : (a.cloud_provider === 'aws' ? -1 : 1);

// ── fig-28: where a successful deployment spends its time ───────────────────
// Phases say who is doing the work. Blue and orange stay out of this palette:
// in the chapter they mean AWS and Azure.
const phases = [
  {key:'queue',     label:'GitHub queue and runner setup',                 fill:'#d9d7d0', text:ink.primary},
  {key:'platform',  label:'Platform steps (callbacks, configuration, cleanup)', fill:'#8f8d86', text:'#ffffff'},
  {key:'signin',    label:'Cloud sign-in (OIDC, registry login)',          fill:'#e87ba4', text:ink.primary},
  {key:'images',    label:'Container images (pull, copy to the customer)', fill:'#1baf7a', text:ink.primary},
  {key:'wait',      label:'Fixed wait for the AcrPull grant (Azure only)', fill:'#eda100', text:ink.primary},
  {key:'provision', label:'Provisioning (Terraform, signer code)',          fill:'#4a3aa7', text:'#ffffff'},
];
const phase = Object.fromEntries(phases.map(p => [p.key, p]));
function phaseOf(name){
  if(name === 'Set up job') return 'queue';
  if(/^Post /.test(name)) return 'platform';
  if(/^Configure AWS credentials|^Azure login|^Log in to ACR/.test(name)) return 'signin';
  if(/^Pull source images|^Replicate images|^Retag and push images/.test(name)) return 'images';
  if(/^Allow the AcrPull grant/.test(name)) return 'wait';
  if(/^Setup Terraform$|setup-terraform|^Terraform (init|apply)|^Ensure ECS service-linked role|^Read customer Pinecone key|docs-signer|^Read Terraform outputs/.test(name)) return 'provision';
  if(/^Notify platform|^Fetch tenant secrets|^Parse tenant config|^Checkout platform repo|actions\/checkout|^Compute resource names|^Remove tenant secrets|^Upload deployment outputs|upload-artifact|^Complete job/.test(name)) return 'platform';
  throw new Error(`fig-28: no phase for workflow step "${name}"`);
}

function timeline(run){
  const job = run.jobs[0];
  if(run.jobs.length !== 1) throw new Error(`fig-28: ${run.id} has ${run.jobs.length} jobs; the timeline assumes one`);
  // The queue runs from the platform's recorded start (the Deploy click) to the
  // moment GitHub starts the job; "Set up job" then joins it as runner setup.
  const segments = [{phase:'queue', start:0, end:seconds(run.started_at, job.started_at)}];
  const totals = Object.fromEntries(phases.map(p => [p.key, 0]));
  totals.queue = segments[0].end;
  for(const step of steps(run)){
    if(step.conclusion === 'skipped') continue;
    const p = phaseOf(step.name), start = seconds(run.started_at, step.started_at), end = seconds(run.started_at, step.completed_at);
    totals[p] += end - start;
    // At one-second resolution a zero-length step has no extent to draw, and
    // drawing it would only split the segments either side of it.
    if(end === start) continue;
    const last = segments.at(-1);
    if(last.phase === p && start - last.end <= 1) last.end = Math.max(last.end, end);
    else segments.push({phase:p, start, end});
  }
  const wall = segments.at(-1).end;
  return {run, segments, totals, wall, recorded:seconds(run.started_at, run.finished_at)};
}

function figTimeline(){
  const rows = deploys.filter(c => c.status === 'succeeded').sort(byCloudThenTime).map(timeline);
  const W = 1240, left = 60, x0 = 290, x1 = 1060;
  const maxMin = Math.ceil(Math.max(...rows.map(r => r.wall)) / 120) * 2;
  const px = s => x0 + (s / (maxMin * 60)) * (x1 - x0);
  const share = (r, key) => r.totals[key] / r.wall;
  const provShares = rows.map(r => share(r, 'provision'));
  const signinMax = Math.max(...rows.map(r => r.totals.signin));
  const platformMax = Math.max(...rows.map(r => r.totals.platform));
  let b = '';

  b += text(left, 44, 'Where a successful deployment spends its time', {size:16, weight:'bold'});
  b += text(left, 66, `Every step of the ${rows.length} successful deployments of ${version}, from the operator's Deploy click. Provisioning takes ${Math.round(Math.min(...provShares) * 100)}–${Math.round(Math.max(...provShares) * 100)}% of each run;`, {size:11.5, fill:ink.muted});
  b += text(left, 84, `the platform's own steps take at most ${duration(platformMax)}, and the cloud sign-ins at most ${duration(signinMax)} per run.`, {size:11.5, fill:ink.muted});

  const top = 128, rowGap = 60, barH = 24, plotBottom = top + rows.length * rowGap - 12;
  // Grid and axis first, so the bars sit on top of them.
  for(let m = 0; m <= maxMin; m += 2){
    const x = px(m * 60);
    b += `<line x1="${x}" y1="${top - 14}" x2="${x}" y2="${plotBottom}" stroke="${ink.rule}" stroke-width="1"/>`;
    b += text(x, plotBottom + 18, String(m), {size:10.5, fill:ink.faint, anchor:'middle'});
  }
  b += `<line x1="${x0}" y1="${plotBottom}" x2="${x1}" y2="${plotBottom}" stroke="${ink.axis}" stroke-width="1.5"/>`;
  b += text((x0 + x1) / 2, plotBottom + 38, 'Minutes since the operator clicked Deploy', {size:11, fill:ink.muted, anchor:'middle'});

  rows.forEach((r, i) => {
    const y = top + i * rowGap, c = cloud[r.run.cloud_provider];
    b += swatch(left, y + 6, c.fill);
    b += text(left + 20, y + 16, c.label, {size:12.5, weight:'bold'});
    b += text(left + 76, y + 16, `${day(r.run.started_at)} 2026`, {size:12, fill:ink.secondary});
    b += text(left + 20, y + 33, `run ${r.run.id.slice(0, 8)} · commit ${r.run.github.head_sha.slice(0, 7)}`, {size:10.5, fill:ink.muted});
    for(const s of r.segments){
      // A 2 px surface gap separates touching segments; a segment too short to
      // keep its gap is drawn as a sliver, so no step disappears entirely.
      const sx = px(s.start), ex = px(s.end), w = Math.max(1.2, ex - sx - 2);
      const p = phase[s.phase];
      b += `<rect x="${(sx + 1).toFixed(2)}" y="${y}" width="${w.toFixed(2)}" height="${barH}" fill="${p.fill}"><title>${esc(`${p.label}: ${duration(s.end - s.start)}`)}</title></rect>`;
      // Names only: a segment can be one part of its phase, so a duration here
      // would disagree with the phase total in the table below.
      const label = {provision:'Provisioning', wait:'Wait', images:'Images'}[s.phase];
      if(label && textWidth(label, 10.5, s.phase === 'provision') + 12 <= w) b += text(sx + 1 + w / 2, y + barH / 2 + 4, label, {size:10.5, fill:p.text, anchor:'middle', weight:s.phase === 'provision' ? 'bold' : undefined});
    }
    b += text(px(r.wall) + 10, y + barH / 2 + 4.5, duration(r.wall), {size:12.5, weight:'bold'});
  });

  // The table is the figure's legend and its exact values at once.
  const tTop = plotBottom + 78, cols = [760, 910, 1060];
  b += text(left, tTop, 'TIME PER PHASE', {size:11, weight:'bold', fill:ink.muted});
  rows.forEach((r, i) => {
    const c = cloud[r.run.cloud_provider];
    b += text(cols[i], tTop, `${c.label} · ${day(r.run.started_at)}`, {size:11, weight:'bold', fill:ink.secondary, anchor:'end'});
  });
  b += `<line x1="${left}" y1="${tTop + 8}" x2="${cols[2]}" y2="${tTop + 8}" stroke="${ink.axis}" stroke-width="1"/>`;
  phases.forEach((p, j) => {
    const y = tTop + 30 + j * 24;
    b += swatch(left, y - 10, p.fill);
    b += text(left + 22, y, p.label, {size:11.5, fill:ink.secondary});
    rows.forEach((r, i) => {
      const v = r.totals[p.key];
      b += text(cols[i], y, v > 0 ? `${duration(v)} · ${percent(share(r, p.key))}` : '—', {size:11.5, fill:v > 0 ? ink.primary : ink.faint, anchor:'end'});
    });
    b += `<line x1="${left}" y1="${y + 8}" x2="${cols[2]}" y2="${y + 8}" stroke="${ink.rule}" stroke-width="1"/>`;
  });
  const totalY = tTop + 30 + phases.length * 24 + 4;
  b += text(left + 22, totalY, 'Deploy click to the end of the job', {size:11.5, weight:'bold'});
  rows.forEach((r, i) => { b += text(cols[i], totalY, duration(r.wall), {size:11.5, weight:'bold', anchor:'end'}); });
  b += text(left + 22, totalY + 22, 'Duration the platform recorded (until the success callback)', {size:11, fill:ink.muted});
  rows.forEach((r, i) => { b += text(cols[i], totalY + 22, duration(r.recorded), {size:11, fill:ink.muted, anchor:'end'}); });

  const fTop = totalY + 62;
  const notes = [
    'Source: docs/evaluation/oidc/history.json, GitHub job and step timings archived from each run (one-second resolution). The queue segment runs from the platform\'s recorded',
    'start to the moment GitHub started the job. Phase shares are of the whole bar. Apply time depends on what earlier attempts had already created, and these records do not',
    `tell a fresh creation from a redeployment. n = ${rows.length}: a description of these runs, not an estimate of typical duration.`,
  ];
  notes.forEach((n, i) => { b += text(left, fTop + i * 18, n, {size:11, fill:ink.muted}); });
  const H = fTop + notes.length * 18 + 16;
  const aria = `Step-by-step timelines of ${rows.length} successful deployments. ` + rows.map(r => `${cloud[r.run.cloud_provider].label} on ${day(r.run.started_at)}: ${duration(r.wall)}, of which provisioning ${duration(r.totals.provision)}`).join('; ') + '.';
  return svg(W, H, aria, b);
}

// ── fig-29: how far each deployment attempt got ─────────────────────────────
// Stages follow each cloud's own workflow order; the two pipelines differ, so
// each cloud gets its own panel rather than a shared set of columns.
const stages = {
  aws:[
    ['Start', /^Notify platform — run started|actions\/checkout/],
    ['Platform sign-in (image source)', /^Configure AWS credentials \(platform role/],
    ['Pull images', /^Pull source images/],
    ['Customer sign-in (OIDC)', /^Configure AWS credentials \(client/],
    ['Copy images to customer', /^Replicate images/],
    ['Terraform init', /^Ensure ECS service-linked role|setup-terraform|^Terraform init|^Read customer Pinecone key|^Install docs-signer/],
    ['Terraform apply', /^Terraform apply$/],
    ['Outputs and callback', /^Grant the docs-signer|^Read Terraform outputs|^Upload deployment outputs|upload-artifact|^Notify platform — success/],
  ],
  azure:[
    ['Start', /^Notify platform — run started|^Fetch tenant secrets|^Parse tenant config|^Checkout platform repo|^Compute resource names/],
    ['Platform sign-in (image source)', /^Configure AWS credentials \(platform role/],
    ['Pull images', /^Pull source images/],
    ['Customer sign-in (OIDC)', /^Azure login/],
    ['Terraform init', /^Setup Terraform$|^Terraform init/],
    ['Bootstrap apply', /^Terraform apply — bootstrap/],
    ['Wait for AcrPull grant', /^Allow the AcrPull grant/],
    ['Push images to customer', /^Log in to ACR|^Retag and push images/],
    ['Full apply', /^Terraform apply — full deploy/],
    ['Outputs and callback', /^Remove tenant secrets|^Read Terraform outputs|^Install docs-signer|^Deploy docs-signer|^Upload deployment outputs|upload-artifact|^Notify platform — success/],
  ],
};
// Steps that are bookkeeping around the pipeline rather than a stage of it.
// Removing the tenant's secrets runs even after a failure (if: always()), so
// counting it would mark a stage the run never reached as passed.
const outsideStages = /^Set up job$|^Post |^Complete job$|^Notify platform — failure$|^Remove tenant secrets/;
const oidcStage = 'Customer sign-in (OIDC)';
// What a failure was, in the words the subtitle uses: both clouds' applies are
// Terraform applies, however each workflow names them.
const failureKind = name => /apply/i.test(name) ? 'Terraform apply' : /images/i.test(name) ? 'the image push' : name;

function progress(run){
  const defs = stages[run.cloud_provider], buckets = defs.map(() => []);
  for(const step of steps(run)){
    if(outsideStages.test(step.name)) continue;
    const i = defs.findIndex(([, re]) => re.test(step.name));
    if(i < 0) throw new Error(`fig-29: no ${run.cloud_provider} stage for workflow step "${step.name}"`);
    buckets[i].push(step);
  }
  return buckets.map(list => {
    if(list.some(s => s.conclusion === 'failure')) return 'fail';
    if(list.some(s => s.conclusion === 'success')) return 'pass';
    return 'none';
  });
}
function commitsBetween(from, to){
  if(from === to) return [];
  return execFileSync('git', ['log', '--reverse', '--format=%h%x09%s', `${from}..${to}`], {encoding:'utf8'})
    .trim().split('\n').filter(Boolean).map(line => { const [sha, ...subject] = line.split('\t'); return {sha, subject:subject.join('\t')}; });
}

const cell = {
  pass:(x, y) => `<circle cx="${x}" cy="${y}" r="9" fill="${good.tint}" stroke="${good.solid}" stroke-width="1.2"/><polyline points="${x-4},${y} ${x-1},${y+3.5} ${x+4.5},${y-3.5}" fill="none" stroke="${good.solid}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`,
  fail:(x, y) => `<circle cx="${x}" cy="${y}" r="9" fill="${bad.solid}"/><path d="M${x-3.5},${y-3.5} L${x+3.5},${y+3.5} M${x+3.5},${y-3.5} L${x-3.5},${y+3.5}" stroke="#ffffff" stroke-width="2" stroke-linecap="round"/>`,
  none:(x, y) => `<circle cx="${x}" cy="${y}" r="8.5" fill="#ffffff" stroke="${ink.faint}" stroke-width="1" stroke-dasharray="3 2.5"/>`,
};

function figProgress(){
  const W = 1240, left = 60, colX = 280, colW = 60, notesX = 910, notesChars = 50, lineH = 13;
  const runs = [...deploys].sort(byCloudThenTime);
  const tenantNo = {};
  let b = '', y = 0;
  const all = runs.map(run => ({run, cells:progress(run)}));
  const oidcPassed = all.filter(a => a.cells[stages[a.run.cloud_provider].findIndex(([n]) => n === oidcStage)] === 'pass').length;
  const failedAt = {};
  for(const a of all){ const i = a.cells.indexOf('fail'); if(i >= 0){ const k = failureKind(stages[a.run.cloud_provider][i][0]); failedAt[k] = (failedAt[k] ?? 0) + 1; } }
  const failSummary = Object.entries(failedAt).sort((p, q) => q[1] - p[1]).map(([k, n]) => `${n} in ${k}`).join(' and ');

  b += text(left, 44, 'How far each deployment attempt got', {size:16, weight:'bold'});
  b += text(left, 66, `All ${all.length} attempts at ${version} or later, in the order they ran. The customer sign-in passed in ${oidcPassed} of ${all.length}; every failure came`, {size:11.5, fill:ink.muted});
  b += text(left, 84, `after it: ${failSummary}.`, {size:11.5, fill:ink.muted});
  // Legend
  b += cell.pass(left + 9, 112) + text(left + 24, 116, 'Every step in the stage succeeded', {size:11, fill:ink.secondary});
  b += cell.fail(left + 239, 112) + text(left + 254, 116, 'A step in the stage failed', {size:11, fill:ink.secondary});
  b += cell.none(left + 423, 112) + text(left + 438, 116, 'Not reached', {size:11, fill:ink.secondary});
  y = 150;

  for(const key of ['aws', 'azure']){
    const panel = all.filter(a => a.run.cloud_provider === key), defs = stages[key], c = cloud[key];
    if(!panel.length) continue;
    const tenants = new Set(panel.map(a => a.run.tenant_id)).size, ok = panel.filter(a => a.run.status === 'succeeded').length;
    b += swatch(left, y - 11, c.fill);
    b += text(left + 20, y, c.label, {size:13, weight:'bold'});
    b += text(left + 20 + textWidth(c.label, 13, true) + 10, y, `${panel.length} attempts on ${tenants} ${tenants === 1 ? 'tenant' : 'tenants'} · ${ok} succeeded`, {size:12, fill:ink.secondary});
    const headTop = y + 22, headLines = 4, rowsTop = headTop + headLines * 13 + 14;
    const oi = defs.findIndex(([n]) => n === oidcStage);
    // Each row is as tall as its commit list, so no subject is cut short.
    const notes = panel.map((a, r) => {
      const prev = panel[r - 1], run = a.run;
      if(!prev) return [{t:`First attempt in the period (commit ${run.github.head_sha.slice(0, 7)})`, muted:true}];
      const commits = commitsBetween(prev.run.github.head_sha, run.github.head_sha);
      if(!commits.length) return [{t:`None: same commit (${run.github.head_sha.slice(0, 7)})`, muted:true}];
      return commits.flatMap(cm => wrap(`${cm.sha} ${cm.subject}`, notesChars).map(t => ({t})));
    });
    const heights = notes.map(n => Math.max(54, 4 + n.length * lineH + 20));
    const offsets = heights.map((_, r) => heights.slice(0, r).reduce((s, h) => s + h, 0));
    const panelBottom = rowsTop + heights.reduce((s, h) => s + h, 0) - 4;
    // The OIDC column is the one the federation claim rests on, so it is banded.
    b += `<rect x="${colX + oi * colW + 3}" y="${headTop - 12}" width="${colW - 6}" height="${panelBottom + 22 - (headTop - 12)}" rx="4" fill="${ink.band}"/>`;
    defs.forEach(([name], i) => {
      const lines = wrap(name, 12), cx = colX + i * colW + colW / 2;
      lines.forEach((l, k) => { b += text(cx, headTop + k * 13, l, {size:10.5, fill:i === oi ? ink.primary : ink.secondary, anchor:'middle', weight:i === oi ? 'bold' : undefined}); });
    });
    b += text(notesX, headTop, 'COMMITS SINCE THE PREVIOUS ATTEMPT', {size:10.5, weight:'bold', fill:ink.muted});
    b += `<line x1="${left}" y1="${rowsTop - 14}" x2="${W - 40}" y2="${rowsTop - 14}" stroke="${ink.axis}" stroke-width="1"/>`;

    panel.forEach((a, r) => {
      const ry = rowsTop + offsets[r], cy = ry + 10, run = a.run;
      tenantNo[run.tenant_id] ??= Object.keys(tenantNo).filter(t => all.find(x => x.run.tenant_id === t).run.cloud_provider === key).length + 1;
      b += text(left, cy + 4, `${day(run.started_at)} · ${clock(run.started_at)} UTC`, {size:12, weight:'bold'});
      b += text(left, cy + 21, `tenant ${tenantNo[run.tenant_id]} · ${duration(seconds(run.started_at, run.finished_at))} · ${run.status}`, {size:10.5, fill:ink.muted});
      const reached = a.cells.reduce((last, s, i) => s === 'none' ? last : i, 0);
      b += `<line x1="${colX + colW / 2}" y1="${cy}" x2="${colX + reached * colW + colW / 2}" y2="${cy}" stroke="${ink.axis}" stroke-width="2"/>`;
      a.cells.forEach((s, i) => { b += cell[s](colX + i * colW + colW / 2, cy); });
      notes[r].forEach((l, k) => { b += text(notesX, cy + 4 + k * lineH, l.t, {size:10.5, fill:l.muted ? ink.faint : ink.secondary, style:l.muted ? 'italic' : undefined}); });
      if(r < panel.length - 1) b += `<line x1="${left}" y1="${ry + heights[r] - 8}" x2="${W - 40}" y2="${ry + heights[r] - 8}" stroke="${ink.rule}" stroke-width="1"/>`;
    });

    // Passed per stage, under each column.
    const countY = panelBottom + 12;
    b += text(colX - 12, countY, 'Passed', {size:10.5, fill:ink.muted, anchor:'end'});
    defs.forEach((_, i) => {
      const n = panel.filter(a => a.cells[i] === 'pass').length;
      b += text(colX + i * colW + colW / 2, countY, `${n}/${panel.length}`, {size:10.5, fill:i === oi ? ink.primary : ink.muted, anchor:'middle', weight:i === oi ? 'bold' : undefined});
    });
    y = countY + 52;
  }

  const notes = [
    'Source: docs/evaluation/oidc/history.json (GitHub job and step records of each run) and git. Times are UTC. A stage passes when all of its workflow steps succeeded; a',
    'retry on the same tenant is a separate attempt. The commits are those between one attempt\'s workflow version and the next; they are not confirmed root-cause fixes,',
    'which would need the run logs. These are development-history attempts, not controlled trials, so the pass rates describe this period rather than the system\'s reliability.',
  ];
  notes.forEach((n, i) => { b += text(left, y - 18 + i * 18, n, {size:11, fill:ink.muted}); });
  const H = y - 18 + notes.length * 18 + 14;
  const aria = `Progress of ${all.length} deployment attempts through each pipeline stage. The customer OIDC sign-in passed in ${oidcPassed} of ${all.length}. Failures: ${failSummary}.`;
  return svg(W, H, aria, b);
}

(async () => {
  if(!deploys.length){ console.error(`No deployments of ${version} in history.json yet; run evaluate-oidc-deployments.cjs after deploying.`); process.exit(1); }
  if(!deploys.some(c => c.status === 'succeeded')){ console.error('No successful deployment yet; fig-28 needs at least one.'); process.exit(1); }
  await save('fig-28-deployment-timeline', figTimeline());
  await save('fig-29-attempt-progress', figProgress());
})().catch(e => { console.error(e); process.exit(1); });
