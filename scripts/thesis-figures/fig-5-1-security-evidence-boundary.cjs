/* eslint-disable @typescript-eslint/no-require-imports -- Standalone CommonJS figure script. */
// Figure 5.1 — What each local security scenario exercised.
//
//   node scripts/thesis-figures/fig-5-1-security-evidence-boundary.cjs
//
// One row per scenario in src/security-e2e, one column per part of the system
// an attack would pass through. Each cell says how that part took part in the
// scenario: run for real, read from its definition files, simulated, or not
// involved. The whole grid sits inside the local-machine boundary: no scenario
// touched a live cloud. Counts are from docs/evaluation/security-e2e/results.json.
const fs = require('node:fs');
const {C, F, figure, render} = require('./lib.cjs');

const f = figure();
const KIND = {
  real: {fill:C.custTint, stroke:C.cust},
  static: {fill:'#e8eef8', stroke:C.az},
  sim: {fill:'#ffffff', stroke:C.ext, dash:true},
};

const results = JSON.parse(fs.readFileSync('docs/evaluation/security-e2e/results.json', 'utf8'));
const counts = id => { const s = results.scenarios.find(r => r.id === id); return `${s.attacks.refused}/${s.attacks.total} attacks · ${s.controls.succeeded}/${s.controls.total} controls`; };

const X0 = 190, GAP = 6, CW = (704 - 8 - X0 - 3 * GAP) / 4;
const colX = i => X0 + i * (CW + GAP);
const TOP = 16, HEAD_Y = 80, ROW_Y = 94, ROW_H = 62, ROW_GAP = 8;
const rowY = i => ROW_Y + i * (ROW_H + ROW_GAP);
const BOTTOM = rowY(4) - ROW_GAP + 10;

// ── boundaries ──────────────────────────────────────────────────────────
f.group(X0 - 8, TOP, colX(3) + CW + 8 - (X0 - 8), BOTTOM - TOP, 'LOCAL MACHINE', {fill:'#fafbfc', stroke:C.sec, sub:'nothing sent to a cloud or to GitHub'});
['Platform app', 'Database', 'GitHub Actions', 'Cloud decision'].forEach((h, i) =>
  f.text(colX(i) + CW / 2, HEAD_Y, h, {size:F.small, weight:'bold', fill:C.sec, anchor:'middle'}));

// ── cells ───────────────────────────────────────────────────────────────
function cell(col, row, kind, lines){
  const x = colX(col), y = rowY(row);
  if(!kind){
    f.text(x + CW / 2, y + ROW_H / 2 + 4, '—', {size:F.body, fill:C.faint, anchor:'middle'});
    return;
  }
  const k = KIND[kind];
  f.add(`<rect x="${x}" y="${y}" width="${CW}" height="${ROW_H}" rx="5" fill="${k.fill}" stroke="${k.stroke}" stroke-width="1.3"${k.dash ? ' stroke-dasharray="5 3.5"' : ''}/>`);
  const first = y + ROW_H / 2 - (lines.length - 1) * 7.5 + 4;
  lines.forEach((l, i) => f.text(x + CW / 2, first + i * 15, l, {size:F.small, fill:C.ink, anchor:'middle'}));
}

const rows = [
  {id:'SEC-E2E-01', title:'Cross-tenant authorization', cells:[
    ['real', ['server actions,', 'API routes']], ['real', ['PostgreSQL,', 'real migrations']], ['sim', ['dispatch', 'recorded']], null]},
  {id:'SEC-E2E-02', title:'Document-access denial', cells:[
    ['static', ['dependencies,', 'DB schema']], null, null, ['static', ['IAM model on', 'templates, TF']]]},
  {id:'SEC-E2E-03', title:'Cloud identity isolation', cells:[
    ['real', ['secrets release']], ['real', ['PostgreSQL,', 'AES-GCM']], ['sim', ['OIDC token', 'signed locally']], ['sim', ['STS and Entra', 'decisions']]]},
  {id:'SEC-E2E-04', title:'Workflow integrity', cells:[
    null, null, ['real', ['committed', 'scripts in bash']], ['sim', ['aws, az, docker', 'stubbed']]]},
];

rows.forEach((r, i) => {
  const y = rowY(i);
  f.text(16, y + 18, r.id, {size:F.title, weight:'bold'});
  f.text(16, y + 35, r.title, {size:F.small, fill:C.sec});
  f.text(16, y + 52, counts(r.id), {size:F.small, fill:C.mut});
  r.cells.forEach((c, col) => cell(col, i, c?.[0], c?.[1]));
});

// ── legend ──────────────────────────────────────────────────────────────
const LY = BOTTOM + 30;
let lx = 16;
for(const [kind, name] of [['real', 'run for real'], ['static', 'read from its definition files'], ['sim', 'simulated or stubbed']]){
  const k = KIND[kind];
  f.add(`<rect x="${lx}" y="${LY - 12}" width="30" height="16" rx="3" fill="${k.fill}" stroke="${k.stroke}" stroke-width="1.2"${k.dash ? ' stroke-dasharray="5 3.5"' : ''}/>`);
  f.text(lx + 38, LY, name, {size:F.small, fill:C.sec});
  lx += 38 + name.length * 5.8 + 28;
}
f.text(lx, LY, '—  not involved', {size:F.small, fill:C.sec});

const H = LY + 18;
render('fig-5-1-security-evidence-boundary', f.svg(H, 'What each local security scenario exercised. SEC-E2E-01 runs the platform’s server actions, API routes and SQL for real against PostgreSQL, with GitHub dispatch recorded. SEC-E2E-02 reads dependencies, the database schema, templates and Terraform and evaluates them with an IAM model. SEC-E2E-03 runs the secrets release for real against PostgreSQL with AES-GCM, with a locally signed OIDC token and simulated STS and Entra decisions. SEC-E2E-04 runs the committed workflow scripts in bash with cloud command-line tools stubbed. No scenario exercised a live AWS or Azure environment.'), H);
