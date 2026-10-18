/* eslint-disable @typescript-eslint/no-require-imports -- Standalone CommonJS evaluation script. */
// Thesis figures for the security evaluation, drawn from its recorded results:
//
//   fig-24-security-test-results  every test, initial run beside current run
//   fig-25-s2-access-chain        the S2 (AWS) access chain, step by step
//
//   node scripts/plot-security-evaluation.cjs
//
// Reads docs/evaluation/security/results.json and, when present, the initial run
// kept in baseline/results.json. Writes SVG for the thesis and a print-resolution
// PNG beside it into docs/figures/. Colours and type follow the other figures there.
// Status is carried by an icon, a word and a fill style together, so a grayscale
// print loses nothing.
const fs = require('node:fs');
const sharp = require('sharp');

const dir = 'docs/evaluation/security', out = 'docs/figures';
const current = JSON.parse(fs.readFileSync(`${dir}/results.json`,'utf8'));
const initial = fs.existsSync(`${dir}/baseline/results.json`) ? JSON.parse(fs.readFileSync(`${dir}/baseline/results.json`,'utf8')) : null;

const ink = {primary:'#16181d', secondary:'#3d4350', muted:'#5b6270', faint:'#898781', rule:'#e1e0d9'};
const good = {solid:'#146b58', tint:'#e9f3ef'}, bad = {solid:'#a13b12', tint:'#f8ebe5'};
const esc = s => String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const text = (x, y, s, {size = 12, fill = ink.primary, weight, anchor} = {}) => `<text x="${x}" y="${y}" font-size="${size}" fill="${fill}"${weight ? ` font-weight="${weight}"` : ''}${anchor ? ` text-anchor="${anchor}"` : ''}>${esc(s)}</text>`;
const mask = s => String(s).replace(/\b\d{12}\b/g,'<account>');
const day = iso => new Date(iso).toLocaleDateString('en-GB', {timeZone:'Europe/Warsaw', day:'numeric', month:'short', year:'numeric'});
function wrap(s, max){ const lines = []; let line = ''; for(const word of String(s).split(' ')){ if(line && (line + ' ' + word).length > max){ lines.push(line); line = word; } else line = line ? `${line} ${word}` : word; } if(line) lines.push(line); return lines; }

// Drawn rather than typed: Arial has no check or cross glyph, and a fallback font
// would change between renderers.
const icon = {
  pass:(x, y, c) => `<polyline points="${x-5},${y} ${x-1.5},${y+4} ${x+5.5},${y-4.5}" fill="none" stroke="${c}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>`,
  fail:(x, y, c) => `<path d="M${x-4.5},${y-4.5} L${x+4.5},${y+4.5} M${x+4.5},${y-4.5} L${x-4.5},${y+4.5}" stroke="${c}" stroke-width="2.2" stroke-linecap="round"/>`,
  none:(x, y, c) => `<line x1="${x-4.5}" y1="${y}" x2="${x+4.5}" y2="${y}" stroke="${c}" stroke-width="2.2" stroke-linecap="round"/>`,
};
const styles = {
  'PASS':{label:'Pass', kind:'pass'}, 'PASS (static)':{label:'Pass (static)', kind:'pass'}, 'PASS (git only)':{label:'Pass (git only)', kind:'pass'},
  'FAIL':{label:'Fail', kind:'fail'}, 'NOT RUN':{label:'Not run', kind:'none'}, 'INCONCLUSIVE':{label:'Inconclusive', kind:'none'},
};
function badge(x, y, w, h, result){
  const s = styles[result] ?? {label:result, kind:'none'}, cy = y + h/2;
  if(s.kind === 'fail') return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="4" fill="${bad.solid}"/>${icon.fail(x+16, cy, '#ffffff')}${text(x+30, cy+4.5, s.label, {fill:'#ffffff', weight:'bold'})}`;
  if(s.kind === 'pass') return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="4" fill="${good.tint}" stroke="${good.solid}" stroke-width="1"/>${icon.pass(x+16, cy, good.solid)}${text(x+30, cy+4.5, s.label, {fill:ink.primary})}`;
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="4" fill="none" stroke="${ink.faint}" stroke-width="1" stroke-dasharray="4 3"/>${icon.none(x+16, cy, ink.faint)}${text(x+30, cy+4.5, s.label, {fill:ink.muted})}`;
}
function svg(width, height, label, body){
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="${esc(label)}">\n  <rect x="0" y="0" width="${width}" height="${height}" fill="#ffffff"/>\n  <g font-family="Arial, Helvetica, sans-serif">${body}</g>\n</svg>\n`;
}
async function save(name, content){
  fs.writeFileSync(`${out}/${name}.svg`, content);
  await sharp(Buffer.from(content), {density:216}).png().toFile(`${out}/${name}.png`);
  console.log(`Wrote ${out}/${name}.svg and .png`);
}

// ── fig-24: the results matrix ───────────────────────────────────────────
const order = ['S1','S2','S3','S4','S5','S6','S7','S8','S9','S10'];
const claimOf = id => current.results.find(r => r.id === id)?.claim ?? '';
const resultOf = (run, id, cloud) => run?.results.find(r => r.id === id && (r.cloud === cloud || r.cloud === 'both'))?.result ?? null;
function matrix(){
  const runs = initial ? [['Initial run', initial], ['Current', current]] : [['Result', current]];
  const cell = {w:112, h:32, gap:6}, groupGap = 30, left = 60, claimX = 100, gridX = 720, top = 176, row = 46;
  const groupWidth = runs.length * cell.w + (runs.length - 1) * cell.gap;
  const groupX = cloud => gridX + (cloud === 'aws' ? 0 : groupWidth + groupGap);
  const width = Math.max(1240, groupX('azure') + groupWidth + 60);
  let body = text(left, 44, 'Security claims as executable tests', {size:16, weight:'bold'});
  const when = !initial ? `Run of ${day(current.extracted_at)}` : day(initial.extracted_at) === day(current.extracted_at) ? `Initial and current runs on ${day(current.extracted_at)}` : `Initial run ${day(initial.extracted_at)} and current run ${day(current.extracted_at)}`;
  body += text(left, 66, `${when}, produced by scripts/evaluate-security.cjs. Each row is one claim from SECURITY.md or ARCHITECTURE.md.`, {size:11.5, fill:ink.muted});
  body += badge(left, 84, 92, 24, 'PASS') + badge(left + 104, 84, 92, 24, 'FAIL') + badge(left + 208, 84, 104, 24, 'NOT RUN');
  body += text(left + 326, 100, '"Static": proven from the code and the deployed policies, not by a live attack.', {size:11, fill:ink.muted});
  for(const cloud of ['aws','azure']){
    const x = groupX(cloud);
    body += text(x + groupWidth/2, 142, cloud === 'aws' ? 'AWS' : 'Azure', {size:13, weight:'bold', anchor:'middle'});
    body += `<line x1="${x}" y1="149" x2="${x + groupWidth}" y2="149" stroke="${ink.faint}" stroke-width="1"/>`;
    runs.forEach(([label], i) => { body += text(x + i*(cell.w + cell.gap) + cell.w/2, 166, label, {size:11, fill:ink.muted, anchor:'middle'}); });
  }
  body += text(left, 166, 'Test', {size:11, fill:ink.muted}) + text(claimX, 166, 'Claim under test', {size:11, fill:ink.muted});
  const changed = [];
  order.forEach((id, i) => {
    const y = top + i*row;
    body += `<line x1="${left}" y1="${y + row - 1}" x2="${width - 60}" y2="${y + row - 1}" stroke="${ink.rule}" stroke-width="1"/>`;
    body += text(left, y + 25, id, {size:12.5, weight:'bold'}) + text(claimX, y + 25, claimOf(id), {size:12.5, fill:ink.secondary});
    for(const cloud of ['aws','azure']){
      runs.forEach(([, run], j) => {
        const x = groupX(cloud) + j*(cell.w + cell.gap), result = resultOf(run, id, cloud);
        // Absent from the run altogether: the test was added after it.
        const label = run.results.some(r => r.id === id) ? 'n/a' : 'added later';
        body += result ? badge(x, y + 7, cell.w, cell.h, result) : text(x + cell.w/2, y + 27, label, {size:11.5, fill:ink.faint, anchor:'middle'});
      });
      const before = resultOf(initial, id, cloud), after = resultOf(current, id, cloud);
      if(initial && before && after && before !== after) changed.push(`${id} on ${cloud === 'aws' ? 'AWS' : 'Azure'}: ${styles[before]?.label ?? before} → ${styles[after]?.label ?? after}`);
    }
  });
  const foot = top + order.length*row + 26;
  body += text(left, foot, changed.length ? `Changed since the initial run: ${changed.join('; ')}.` : initial ? 'No result changed since the initial run.' : '', {size:11.5, fill:ink.secondary});
  body += text(left, foot + 20, 'n/a: the test concerns the other cloud only. Added later: the test did not exist at the initial run. Not run: needs live infrastructure the evaluation did not provision (two tenants at once for S1, CloudTrail for S4).', {size:11, fill:ink.muted});
  const failing = order.filter(id => ['aws','azure'].some(c => resultOf(current, id, c) === 'FAIL'));
  return svg(width, foot + 44, `Security test results. Currently failing: ${failing.join(', ') || 'none'}.`, body);
}

// ── fig-25: the S2 access chain ──────────────────────────────────────────
const holderText = {OperatorSignInSession:'The operator\'s AWS sign-in session (temporary credentials only)', HostWorkloadIdentity:'The hosted platform on Vercel, production environment only (OIDC)'};
// A run records either one chain (the initial run: the platform's single way
// in) or one path per role the bootstrap template creates (after the fix).
// A path reaches the documents when the platform may assume the role, the
// role trusts it, and the role may read or list the bucket.
function chain(run){
  const s2 = run.results.find(r => r.id === 'S2' && r.cloud === 'aws');
  const yes = d => d === 'Allow';
  const groups = s2?.paths ? s2.paths.map(p => ({title:`Through ${p.role}`, links:p.links, complete:p.complete}))
    : s2?.links ? [{title:null, links:s2.links, complete:s2.links.every(l => yes(l.outcome.decision))}] : null;
  if(!groups) return null;
  const left = 60, boxW = 720, badgeX = left + boxW + 16, panelX = 900, width = 1240;
  let body = text(left, 44, 'Can the platform reach an AWS tenant\'s documents? (test S2)', {size:16, weight:'bold'});
  body += text(left, 66, s2.paths
    ? `Every role the bootstrap template creates, evaluated against the platform's policy as written and as deployed (run of ${day(run.extracted_at)}).`
    : `Each step was evaluated against the deployed control-plane policy and the bootstrap template (run of ${day(run.extracted_at)}). If every step holds, the platform can read the documents.`, {size:11.5, fill:ink.muted});
  let y = 92, n = 0;
  for(const group of groups){
    if(group.title){ body += text(left, y + 14, group.title, {size:13, weight:'bold'}); y += 26; }
    group.links.forEach((link, i) => {
      n++;
      const lines = wrap(link.step, 100), h = 22 + lines.length*16 + 14;
      const holds = yes(link.outcome.decision);
      body += `<rect x="${left}" y="${y}" width="${boxW}" height="${h}" rx="6" fill="#ffffff" stroke="${holds ? '#c3c2b7' : good.solid}" stroke-width="${holds ? 1 : 1.5}"/>`;
      body += `<circle cx="${left + 20}" cy="${y + 20}" r="11" fill="${ink.secondary}"/>` + text(left + 20, y + 24.5, n, {size:11.5, fill:'#ffffff', weight:'bold', anchor:'middle'});
      lines.forEach((line, k) => { body += text(left + 42, y + 24 + k*16, line, {size:12.5}); });
      body += text(left + 42, y + 24 + lines.length*16 + 2, mask(link.evidence), {size:10.5, fill:ink.faint});
      const by = y + h/2 - 14;
      // "Yes" means the access is possible, which is the bad outcome here, so no
      // check mark: the word carries the answer and the fill carries the risk.
      const tone = holds ? bad : good;
      body += `<rect x="${badgeX}" y="${by}" width="64" height="28" rx="4" fill="${tone.tint}" stroke="${tone.solid}" stroke-width="1"/>${text(badgeX + 32, by + 18.5, holds ? 'Yes' : 'No', {weight:'bold', anchor:'middle'})}`;
      y += h;
      if(i < group.links.length - 1){ body += `<line x1="${left + 20}" y1="${y}" x2="${left + 20}" y2="${y + 14}" stroke="${ink.faint}" stroke-width="1.5"/><path d="M${left + 15},${y + 9} L${left + 20},${y + 15} L${left + 25},${y + 9}" fill="none" stroke="${ink.faint}" stroke-width="1.5"/>`; y += 16; }
    });
    if(group.title){ body += text(left, y + 20, group.complete ? 'This path reaches the documents.' : 'This path is broken: no step sequence leads from the platform to the documents.', {size:11.5, fill:group.complete ? bad.solid : ink.muted, weight:group.complete ? 'bold' : undefined}); y += 34; }
    else y += 8;
  }
  y += 10;
  const complete = groups.some(g => g.complete);
  const brokenAt = groups.length === 1 ? groups[0].links.findIndex(l => !yes(l.outcome.decision)) : -1;
  const verdict = complete
    ? (s2.paths ? `A path reaches the documents, so the platform can read AWS tenants' documents. The claim fails.` : `Every step holds, so the platform can read every AWS tenant's documents. The claim fails.`)
    : (s2.paths ? `No path reaches the documents, so the platform cannot read them. The claim holds.` : `The chain breaks at step ${brokenAt + 1}, so the platform cannot read the documents. The claim holds.`);
  body += complete ? `<rect x="${left}" y="${y}" width="${boxW + 80}" height="40" rx="6" fill="${bad.solid}"/>${icon.fail(left + 20, y + 20, '#ffffff')}${text(left + 38, y + 25, verdict, {size:13, fill:'#ffffff', weight:'bold'})}`
    : `<rect x="${left}" y="${y}" width="${boxW + 80}" height="40" rx="6" fill="${good.tint}" stroke="${good.solid}" stroke-width="1.5"/>${icon.pass(left + 20, y + 20, good.solid)}${text(left + 38, y + 25, verdict, {size:13, weight:'bold'})}`;
  const bottom = y + 40;
  // Side panel: the controls that keep a FAIL honest, and who holds the first link.
  let py = 100;
  body += text(panelX, py, 'Negative controls', {size:13, weight:'bold'}); py += 18;
  const intro = wrap('Each must be refused; otherwise the evaluator would be too permissive to trust.', 40);
  body += intro.map((l, k) => text(panelX, py + k*15, l, {size:11, fill:ink.muted})).join(''); py += intro.length*15 + 16;
  for(const c of s2.controls){
    const refused = c.outcome.decision !== 'Allow', lines = wrap(c.step, 38);
    body += (refused ? icon.pass(panelX + 7, py - 4, good.solid) : icon.fail(panelX + 7, py - 4, bad.solid));
    lines.forEach((l, k) => { body += text(panelX + 20, py + k*15, l, {size:11.5, fill:ink.secondary}); });
    body += text(panelX + 20, py + lines.length*15, refused ? `Refused (${c.outcome.decision})` : 'ALLOWED: evaluator not trustworthy', {size:10.5, fill:refused ? ink.faint : bad.solid}); py += lines.length*15 + 24;
  }
  // A fix that closed the path by breaking onboarding would prove nothing.
  if(s2.functional?.length){
    py += 10;
    body += text(panelX, py, 'Onboarding still works', {size:13, weight:'bold'}); py += 20;
    for(const f of s2.functional){
      const ok = f.outcome.decision === 'Allow', lines = wrap(f.step, 38);
      body += ok ? icon.pass(panelX + 7, py - 4, good.solid) : icon.fail(panelX + 7, py - 4, bad.solid);
      lines.forEach((l, k) => { body += text(panelX + 20, py + k*15, l, {size:11.5, fill:ink.secondary}); });
      body += text(panelX + 20, py + lines.length*15, ok ? 'Allowed' : `${f.outcome.decision}: onboarding would fail`, {size:10.5, fill:ok ? ink.faint : bad.solid}); py += lines.length*15 + 24;
    }
  }
  py += 10;
  body += text(panelX, py, s2.paths ? 'Who holds the platform role' : 'Who holds step 1', {size:13, weight:'bold'}); py += 20;
  for(const h of s2.holders){
    const sid = h.split(':')[0];
    wrap(holderText[sid] ?? sid, 40).forEach((l, k) => { body += text(panelX, py + k*15, (k ? '' : '• ') + l, {size:11.5, fill:ink.secondary}); });
    py += wrap(holderText[sid] ?? sid, 40).length*15 + 8;
  }
  return svg(width, Math.max(bottom, py) + 30, complete ? 'S2 access chain: the platform can read AWS tenant documents.' : 'S2 access chain: no path leads from the platform to the documents.', body);
}

async function main(){
  await save('fig-24-security-test-results', matrix());
  const now = chain(current);
  const before = initial ? chain(initial) : null;
  // One figure while the chain is unchanged; a before/after pair once a fix lands.
  const decisions = run => { const s2 = run.results.find(r => r.id === 'S2' && r.cloud === 'aws'); return JSON.stringify((s2?.paths?.flatMap(p => p.links) ?? s2?.links)?.map(l => [l.step, l.outcome.decision])); };
  if(before && decisions(initial) !== decisions(current)){ await save('fig-25-s2-access-chain-before', before); await save('fig-25-s2-access-chain-after', now); }
  else if(now) await save('fig-25-s2-access-chain', now);
}
main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
