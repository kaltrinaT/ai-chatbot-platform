/* eslint-disable @typescript-eslint/no-require-imports -- Standalone CommonJS evaluation script. */
// Local end-to-end security evaluation (SEC-E2E-01 … 04).
//
//   npm run evaluate:security:e2e
//
// Runs the scenarios in src/security-e2e and turns what they observed into
// evidence. Nothing is created in AWS or Azure and nothing is sent to GitHub:
// the application runs against an in-process Postgres (PGlite) migrated with
// the repository's own migrations, cloud permissions are evaluated from the
// templates and Terraform that create them, and workflow steps run in local
// bash with cloud CLIs stubbed. These are integration and simulation tests,
// not tests against live clouds — the report says so at the top.
//
// The collector checks, it does not assume:
//   - every scenario pairs refused attacks with succeeding controls, so a
//     system that refused everything would not pass;
//   - every observation agrees with its test's pass/fail result;
//   - no fixture secret and no credential-shaped string appears in the
//     evidence. A record that contains one is withheld and the run fails.
//
// Writes docs/evaluation/security-e2e/: REPORT.md and results.json.
const fs = require('node:fs'); const path = require('node:path'); const os = require('node:os');
const {spawnSync, execSync} = require('node:child_process');
const {keyPatterns} = require('./lib/security-model.cjs');

const dir = 'docs/evaluation/security-e2e'; fs.mkdirSync(dir, {recursive:true});
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'sec-e2e-'));
const evidenceFile = path.join(work, 'evidence.jsonl');
const vitestFile = path.join(work, 'vitest.json');

const scenarios = [
  {id:'SEC-E2E-01', title:'Cross-tenant authorization', lane:'Application',
    claim:'An operator can act on their own tenants and on nothing else; a deployment webhook changes a deployment only forward and only once.',
    method:'The real server actions, API routes and deploy logic against a migrated Postgres (PGlite). Only the session, GitHub dispatch and the tenant\'s signer and backend are replaced, each recording what it was asked to do; the database is read back after every operation.'},
  {id:'SEC-E2E-02', title:'Document-access denial', lane:'Cloud identity',
    claim:'Neither the control plane nor the docs-signer can read or list a tenant\'s documents; the signer can only write and delete.',
    method:'Simulated: AWS policies from the bootstrap template, the tenant Terraform and the control-plane Terraform, evaluated by the IAM model shared with evaluate-security.cjs; Azure role actions from the tenant Terraform.'},
  {id:'SEC-E2E-03', title:'Cloud identity isolation', lane:'Cloud identity',
    claim:'A run for tenant A can sign in to A\'s cloud and fetch A\'s secrets, and cannot do either for tenant B.',
    method:'Simulated STS and Entra ID decisions against the bootstrap templates, with forged token claims; the platform\'s own secrets release run for real against PGlite with AES-GCM ciphertexts and locally signed RS256 tokens.'},
  {id:'SEC-E2E-04', title:'Workflow integrity', lane:'GitHub workflow',
    claim:'Dispatch inputs are only data: they cannot run a command or rewrite another step\'s output.',
    method:'The workflows\' own step scripts executed in local bash with GitHub\'s flags and $GITHUB_OUTPUT semantics; aws, docker, az, terraform and curl stubbed to record their arguments; a canary file detects code execution.'},
];

// ── Run ──────────────────────────────────────────────────────────────────
console.log('Running src/security-e2e …');
const run = spawnSync(process.execPath, [
  'node_modules/vitest/vitest.mjs', 'run', '--config', 'vitest.security.config.mts',
  '--reporter=default', '--reporter=json', `--outputFile.json=${vitestFile}`,
], {stdio:'inherit', env:{...process.env, SECURITY_EVIDENCE_FILE:evidenceFile}});
if(!fs.existsSync(vitestFile)) { console.error('vitest produced no results'); process.exit(run.status || 1); }

const vitest = JSON.parse(fs.readFileSync(vitestFile, 'utf8'));
const records = fs.existsSync(evidenceFile) ? fs.readFileSync(evidenceFile, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
const secrets = [...new Set(records.filter(r => r.type === 'fixture-secret').map(r => r.value))];
const observations = records.filter(r => r.type === 'observation');

// ── Collect ──────────────────────────────────────────────────────────────
const tests = vitest.testResults.flatMap(file => file.assertionResults.map(a => ({
  file:path.relative(process.cwd(), file.name).replace(/\\/g,'/'),
  name:[...a.ancestorTitles, a.title].join(' > '),
  status:a.status, duration:Math.round(a.duration ?? 0),
})));
const scenarioOf = name => scenarios.find(s => name.startsWith(s.id))?.id;

// No secret leaves this machine: a record carrying a fixture secret or a
// credential-shaped string is withheld, and its presence fails the run.
const leaks = [];
for(const o of observations){
  const text = JSON.stringify(o);
  const hits = [...secrets.filter(s => text.includes(s)).map(() => 'fixture secret'),
    ...Object.entries(keyPatterns).filter(([, p]) => p.test(text)).map(([k]) => k)];
  if(hits.length){ leaks.push({scenario:o.scenario, step:o.step, kinds:[...new Set(hits)]}); o.actual = '[withheld: contained a secret]'; o.expected = String(o.expected); }
}

const byTest = new Map(tests.map(t => [t.name, t]));
const results = scenarios.map(s => {
  const own = tests.filter(t => scenarioOf(t.name) === s.id);
  const obs = observations.filter(o => o.scenario === s.id);
  const attacks = obs.filter(o => o.kind === 'attack'), controls = obs.filter(o => o.kind === 'control');
  // An observation must agree with its test: a held claim in a failed test,
  // or a broken one in a passing test, means the evidence is not the test's.
  const disagree = obs.filter(o => { const t = byTest.get(o.test); return !t || (t.status === 'passed') !== o.held; });
  const failed = own.filter(t => t.status !== 'passed');
  const problems = [
    ...(own.length === 0 ? ['no tests ran'] : []),
    ...failed.map(t => `test ${t.status}: ${t.name}`),
    ...(attacks.length === 0 ? ['no attack was observed'] : []),
    ...(controls.length === 0 ? ['no control was observed, so a system refusing everything would pass'] : []),
    ...disagree.map(o => `observation disagrees with its test: ${o.step}`),
    ...leaks.filter(l => l.scenario === s.id).map(l => `secret in evidence (${l.kinds.join(', ')}): ${l.step}`),
  ];
  return {...s, result:problems.length ? 'FAIL' : 'PASS', problems,
    tests:{total:own.length, passed:own.length - failed.length},
    attacks:{total:attacks.length, refused:attacks.filter(o => o.held).length},
    controls:{total:controls.length, succeeded:controls.filter(o => o.held).length},
    observations:obs.map(o => Object.fromEntries(Object.entries(o).filter(([k]) => k !== 'type' && k !== 'scenario')))};
});

// ── Report ───────────────────────────────────────────────────────────────
const git = cmd => { try { return execSync(cmd, {encoding:'utf8', stdio:['ignore','pipe','ignore']}).trim(); } catch { return ''; } };
const commit = git('git rev-parse --short=12 HEAD'), dirty = git('git status --porcelain') !== '';
const pglite = JSON.parse(fs.readFileSync('node_modules/@electric-sql/pglite/package.json', 'utf8')).version;
const generated = new Date().toISOString();
const environment = {node:process.version, platform:`${os.type()} ${os.release()} (${process.platform})`, pglite, vitest:JSON.parse(fs.readFileSync('node_modules/vitest/package.json','utf8')).version, commit, uncommittedChanges:dirty};
const overall = results.every(r => r.result === 'PASS') ? 'PASS' : 'FAIL';

fs.writeFileSync(path.join(dir, 'results.json'), JSON.stringify({generated, overall, environment, secretsChecked:secrets.length, leaks, scenarios:results, tests}, null, 2) + '\n');

const cell = v => String(v).replace(/\|/g, '\\|').replace(/\r?\n/g, '⏎');
const compact = v => { const s = typeof v === 'string' ? v : JSON.stringify(v); return s.length > 220 ? `${s.slice(0, 217)}…` : s; };
const md = [];
md.push('# Security evaluation — local end-to-end', '');
md.push(`Generated ${generated} by \`npm run evaluate:security:e2e\` at commit \`${commit}\`${dirty ? ' with uncommitted changes' : ''}. Node ${environment.node}, ${environment.platform}, PGlite ${pglite}.`, '');
md.push('> **Scope.** No AWS or Azure resource was created and nothing was sent to GitHub. These are automated integration and simulation tests: the application runs against a real, in-process Postgres; cloud permissions are evaluated from the templates and Terraform that create them; workflow steps run in local bash with cloud CLIs stubbed. They show what the code and policies as written decide, not what a live cloud did.', '');
md.push(`**Overall: ${overall}.** ${secrets.length} fixture secrets were searched for in the evidence, together with ${Object.keys(keyPatterns).length} credential patterns: ${leaks.length ? `${leaks.length} record(s) withheld` : 'none found'}.`, '');
md.push('| ID | Lane | Demonstration | Result | Attacks refused | Controls succeeded | Tests |', '|---|---|---|---|---|---|---|');
for(const r of results) md.push(`| ${r.id} | ${r.lane} | ${r.title} | **${r.result}** | ${r.attacks.refused}/${r.attacks.total} | ${r.controls.succeeded}/${r.controls.total} | ${r.tests.passed}/${r.tests.total} |`);
md.push('');
for(const r of results){
  md.push(`## ${r.id} — ${r.title}: ${r.result}`, '', `**Claim.** ${r.claim}`, '', `**Method.** ${r.method}`, '');
  if(r.problems.length) md.push('**Problems:**', '', ...r.problems.map(p => `- ${p}`), '');
  md.push('| | Operation | Required | Observed | Held |', '|---|---|---|---|---|');
  for(const o of r.observations) md.push(`| ${o.kind === 'attack' ? 'attack' : 'control'} | ${cell(o.step)} | ${cell(o.expected)} | \`${cell(compact(o.actual))}\` | ${o.held ? '✓' : '✗'} |`);
  md.push('');
}
fs.writeFileSync(path.join(dir, 'REPORT.md'), md.join('\n'));
fs.rmSync(work, {recursive:true, force:true});

for(const r of results) console.log(`${r.id}  ${r.result.padEnd(4)}  attacks refused ${r.attacks.refused}/${r.attacks.total}  controls ${r.controls.succeeded}/${r.controls.total}  ${r.title}`);
console.log(`\n${overall} — wrote ${dir}/REPORT.md and results.json`);
process.exit(overall === 'PASS' ? 0 : 1);
