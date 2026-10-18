/* eslint-disable @typescript-eslint/no-require-imports -- Standalone CommonJS evaluation script. */
// A clean reproducibility run of every local evaluation.
//
//   npm run evaluate:reproducibility                     the commit HEAD points at
//   npm run evaluate:reproducibility -- --ref <commit>   another commit
//   npm run evaluate:reproducibility -- --working-tree   HEAD plus the uncommitted changes, before committing
//     [--repeat 2] [--skip-docker] [--with-generated] [--keep]
//
// The archived evidence under docs/evaluation was produced on the author's
// machine, in the author's working tree, with the author's environment. This
// shows what survives without any of that: a fresh clone in a temporary
// directory, dependencies installed from the lockfile with `npm ci`, and every
// evaluation run with an environment stripped to what the operating system
// needs — no .env file, no database, no GitHub token, no cloud credentials,
// TZ=UTC. Each fresh result is then compared item by item with the evidence
// archived at the same commit, and the deterministic suites are run more than
// once (--repeat) to catch flaky tests.
//
// What it cannot reproduce is anything that needs a credential: the live
// tests (S1, S4, S5), the database inspection (S7), the CI-log half of S6, and
// fresh deployment data. Those are listed as such, not silently left out. The
// deployment-timing report is rebuilt from its archived runs, which shows the
// analysis is reproducible even though the runs are not.
//
// --working-tree reproduces the current uncommitted state (tracked changes and
// untracked files that are not ignored), identified by a hash of its files.
// That is a rehearsal: the evidence an examiner can repeat is a commit.
//
// Writes docs/evaluation/reproducibility/ in this checkout: REPORT.md,
// results.json and the fresh results it compared.
const fs = require('node:fs'); const path = require('node:path'); const os = require('node:os'); const crypto = require('node:crypto');
const {spawnSync, execFileSync} = require('node:child_process');

const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const has = name => args.includes(name);
const ROOT = process.cwd(), OUT = path.join(ROOT, 'docs/evaluation/reproducibility');
const REPEAT = Math.max(1, Number(option('--repeat', 2)));
const now = () => new Date().toISOString();
const log = m => console.log(`${now().slice(11, 19)}  ${m}`);
const git = (cwd, ...a) => execFileSync('git', a, {cwd, encoding:'utf8', stdio:['ignore', 'pipe', 'pipe'], maxBuffer:1 << 28}).trim();
const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex');
const home = os.homedir();
const scrub = s => String(s ?? '').split(home).join('~');

// ── The environment every step runs in ───────────────────────────────────
// An allowlist, not a blocklist: anything the author's shell exported, a
// token included, is simply absent.
const KEEP = process.platform === 'win32'
  ? ['PATH', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA',
    'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMW6432', 'PROGRAMDATA', 'COMMONPROGRAMFILES', 'COMMONPROGRAMFILES(X86)', 'COMMONPROGRAMW6432', 'SYSTEMDRIVE', 'ALLUSERSPROFILE', 'PUBLIC',
    'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'PROCESSOR_IDENTIFIER', 'OS', 'USERNAME', 'COMPUTERNAME']
  : ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'DOCKER_HOST', 'XDG_RUNTIME_DIR'];
// Windows names are case-insensitive (PATH is often spelled Path), so match them that way.
const kept = k => KEEP.includes(process.platform === 'win32' ? k.toUpperCase() : k);
const ENV = {...Object.fromEntries(Object.keys(process.env).filter(kept).map(k => [k, process.env[k]])), TZ:'UTC', LANG:'C.UTF-8', NO_COLOR:'1', FORCE_COLOR:'0'};
const withheld = Object.keys(process.env).filter(k => !kept(k)).length;

// ── The clean copy ───────────────────────────────────────────────────────
function prepare(work){
  const repo = path.join(work, 'repo');
  const ref = option('--ref', 'HEAD'), sha = git(ROOT, 'rev-parse', ref);
  log(`cloning ${sha.slice(0, 12)} into ${scrub(repo)}`);
  git(ROOT, 'clone', '--quiet', '--no-hardlinks', '--no-checkout', ROOT, repo);
  git(repo, 'checkout', '--quiet', '--detach', sha);
  const source = {mode:'commit', ref, commit:sha};
  // How far the author's working tree is from the commit being reproduced.
  const dirty = git(ROOT, 'status', '--porcelain', '--untracked-files=all').split('\n').filter(Boolean);
  source.author_tree_differs_by = dirty.length;
  if(has('--working-tree')){
    if(option('--ref')) throw new Error('--working-tree reproduces HEAD plus the working tree; drop --ref');
    const files = git(ROOT, 'ls-files', '-co', '--exclude-standard', '-z').split('\0').filter(Boolean);
    const deleted = new Set(git(ROOT, 'ls-files', '-d', '-z').split('\0').filter(Boolean));
    const hash = crypto.createHash('sha256');
    for(const f of files.sort()){
      if(deleted.has(f)){ fs.rmSync(path.join(repo, f), {force:true}); continue; }
      const body = fs.readFileSync(path.join(ROOT, f));
      fs.mkdirSync(path.dirname(path.join(repo, f)), {recursive:true}); fs.writeFileSync(path.join(repo, f), body);
      hash.update(`${f}\0${sha256(body)}\n`);
    }
    for(const f of deleted) fs.rmSync(path.join(repo, f), {force:true});
    Object.assign(source, {mode:'working tree', files:files.length - deleted.size, deleted:deleted.size, tree_sha256:hash.digest('hex'), changed_against_commit:dirty.length});
  }
  // Nothing the author keeps out of git may have come along.
  const leaked = fs.readdirSync(repo).filter(f => /^\.env/.test(f) && !/\.example$/.test(f));
  if(leaked.length) throw new Error(`The clean copy contains ${leaked.join(', ')}; refusing to run`);
  return {repo, source};
}

function versions(repo){
  const v = (bin, a, opts = {}) => { const r = spawnSync(bin, a, {encoding:'utf8', env:ENV, shell:process.platform === 'win32' && opts.shell, timeout:30_000}); return r.status === 0 ? (r.stdout || r.stderr).trim().split('\n')[0] : null; };
  const bash = process.platform === 'win32' && fs.existsSync('C:/Program Files/Git/bin/bash.exe') ? 'C:/Program Files/Git/bin/bash.exe' : 'bash';
  const images = {};
  for(const image of ['pgvector/pgvector:pg16', 'zricethezav/gitleaks:v8.30.1', 'bridgecrew/checkov:3.3.19', 'ghcr.io/zizmorcore/zizmor:1.30.1', 'sha256:d2885e23fc87470361da634242051a00a07848de35d563318a2c7fe2a443077c']){
    const r = spawnSync('docker', ['image', 'inspect', '--format', '{{.Id}} {{join .RepoDigests ","}}', image], {encoding:'utf8', env:ENV});
    images[image] = r.status === 0 ? r.stdout.trim() : null;
  }
  return {os:`${os.type()} ${os.release()} (${process.platform}/${os.arch()})`, cpu:`${os.cpus()[0]?.model?.trim()} × ${os.cpus().length}`, memory_gb:Math.round(os.totalmem() / 2 ** 30),
    node:process.version, npm:v('npm', ['-v'], {shell:true}), git:v('git', ['--version']), bash:v(bash, ['--version']), jq:v(bash, ['-c', 'jq --version']), docker:v('docker', ['version', '--format', '{{.Server.Version}}']),
    lockfile_sha256:sha256(fs.readFileSync(path.join(repo, 'package-lock.json'))), core_autocrlf:(() => { try { return git(repo, 'config', '--get', 'core.autocrlf'); } catch { return null; } })(),
    env:{kept:Object.keys(ENV).sort(), withheld_count:withheld, set:{TZ:'UTC', LANG:'C.UTF-8'}}, docker_images:images};
}

// ── Steps ────────────────────────────────────────────────────────────────
const node = process.execPath, vitest = 'node_modules/vitest/vitest.mjs';
function steps(fresh){
  const s = [
    {id:'install', title:'npm ci', cmd:['npm', 'ci', '--no-audit', '--no-fund'], shell:true, timeout:30},
    {id:'typecheck', title:'TypeScript', cmd:[node, 'node_modules/typescript/bin/tsc', '--noEmit', '--incremental', 'false'], timeout:10},
    {id:'lint', title:'ESLint (src)', cmd:[node, 'node_modules/eslint/bin/eslint.js', 'src', '--format', 'json', '--output-file', path.join(fresh, 'lint.json')], timeout:10, okExit:[0, 1]},
    {id:'unit-1', title:'Unit and attack-matrix tests, with coverage', cmd:[node, vitest, 'run', '--coverage', '--coverage.reporter=json-summary', `--coverage.reportsDirectory=${path.join(fresh, 'coverage')}`, '--reporter=json', `--outputFile=${path.join(fresh, 'unit-1.json')}`], timeout:15},
    ...Array.from({length:REPEAT - 1}, (_, i) => ({id:`unit-${i + 2}`, title:`Unit tests, repeat ${i + 2}`, cmd:[node, vitest, 'run', '--reporter=json', `--outputFile=${path.join(fresh, `unit-${i + 2}.json`)}`], timeout:15})),
    {id:'security-e2e-1', title:'SEC-E2E-01 to 04', cmd:[node, 'scripts/evaluate-security-e2e.cjs'], timeout:30, result:'docs/evaluation/security-e2e/results.json'},
    ...Array.from({length:REPEAT - 1}, (_, i) => ({id:`security-e2e-${i + 2}`, title:`SEC-E2E, repeat ${i + 2}`, cmd:[node, 'scripts/evaluate-security-e2e.cjs'], timeout:30, result:'docs/evaluation/security-e2e/results.json'})),
    {id:'mutation', title:'Security mutation testing (hand-written)', cmd:[node, 'scripts/evaluate-security-mutants.cjs'], timeout:90, okExit:[0, 1], result:'docs/evaluation/security-mutation/results.json'},
    ...(has('--with-generated') ? [{id:'mutation-generated', title:'Security mutation testing (generated)', cmd:[node, 'scripts/evaluate-security-mutants.cjs', '--generated'], timeout:240, result:'docs/evaluation/security-mutation/generated.json'}] : []),
    {id:'deployment-timing', title:'Deployment timing report, rebuilt from the archived runs', cmd:[node, 'scripts/evaluate-deployment-timings.cjs', 'report'], timeout:5, result:'docs/evaluation/deployment-timing/summary.json'},
  ];
  if(!has('--skip-docker')) s.push(
    {id:'security-static', title:'Security evaluation without credentials (S2, S3, S6 git, S8, S9, S10, Checkov, zizmor)', cmd:[node, 'scripts/evaluate-security.cjs', '--skip-logs'], timeout:45, okExit:[0, 1], result:'docs/evaluation/security/results.json'},
    {id:'concurrency', title:'PostgreSQL concurrency', cmd:[node, 'scripts/evaluate-postgres-concurrency.cjs'], timeout:45, result:'docs/evaluation/security-concurrency/results.json'},
    {id:'rag-isolation', title:'RAG cross-tenant privacy (SEC-RAG-01)', cmd:[node, 'scripts/evaluate-rag-isolation.cjs'], timeout:45, okExit:[0, 1], result:'docs/evaluation/rag-isolation/results.json'},
  );
  return s;
}

function run(step, repo, logs){
  const file = path.join(logs, `${step.id}.log`); const fd = fs.openSync(file, 'w');
  const started = Date.now();
  const r = spawnSync(step.cmd[0], step.cmd.slice(1), {cwd:repo, env:ENV, stdio:['ignore', fd, fd], shell:Boolean(step.shell && process.platform === 'win32'), timeout:step.timeout * 60_000});
  fs.closeSync(fd);
  const seconds = Math.round((Date.now() - started) / 1000);
  const exit = r.error?.code === 'ETIMEDOUT' ? 'timeout' : r.status;
  const ok = (step.okExit ?? [0]).includes(exit);
  const tail = ok ? null : scrub(fs.readFileSync(file, 'utf8').split('\n').slice(-15).join('\n'));
  return {id:step.id, title:step.title, command:scrub(step.cmd.map(c => c === node ? 'node' : path.isAbsolute(c) ? path.relative(repo, c) : c).join(' ')), exit, ok, seconds, tail};
}

// ── Comparison ───────────────────────────────────────────────────────────
// Each artefact becomes a flat map of what it claims, so archived and fresh
// can be compared key by key. Timestamps, durations and counts that vary by
// nature (how many requests overlapped, how long a run took) are left out.
const read = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const CLAIMS = {
  'docs/evaluation/security-e2e/results.json':r => ({overall:r.overall, ...Object.fromEntries(r.scenarios.flatMap(s => [[`${s.id} result`, s.result], [`${s.id} attacks refused`, `${s.attacks.refused}/${s.attacks.total}`], [`${s.id} controls succeeded`, `${s.controls.succeeded}/${s.controls.total}`]])),
    leaks:r.leaks.length, ...Object.fromEntries(r.tests.map(t => [`test: ${path.basename(t.file)} › ${t.name}`, t.status]))}),
  'docs/evaluation/security-mutation/results.json':r => ({score:`${r.score.killed}/${r.score.of}`, layered_survivors:r.layeredSurvivors, unexpected:r.unexpected.join(',') || 'none', ...Object.fromEntries(r.mutants.map(m => [m.id, m.outcome]))}),
  'docs/evaluation/security-mutation/generated.json':r => ({score:`${r.score.killed}/${r.score.of}`, ...Object.fromEntries(r.mutants.map(m => [`${m.id} ${m.fingerprint}`, m.outcome]))}),
  'docs/evaluation/security-concurrency/results.json':r => ({overall:r.overall, leaks:r.leaks, ...Object.fromEntries(r.tests.map(t => [t.name, t.status]))}),
  'docs/evaluation/rag-isolation/results.json':r => ({result:r.result, ...Object.fromEntries(r.layouts.flatMap(l => [
    ...l.controls.map(c => [`${l.layout} control ${c.tenant}`, c.result]), ...l.probes.map(p => [`${l.layout} ${p.probe} ${p.tenant}`, p.result]), ...l.checks.map(c => [`${l.layout} ${c.id} ${c.tenant}`, c.result]),
    ...(l.negative_control ? [[`${l.layout} negative control detected`, l.negative_control.detected]] : [])])), image:r.provenance.id}),
  // Only what can run without credentials; S6 is compared on its git half.
  'docs/evaluation/security/results.json':r => ({...Object.fromEntries(r.results.filter(x => !['S1', 'S4', 'S5', 'S7'].includes(x.id)).map(x => [`${x.id} ${x.cloud}`, x.id === 'S6' ? String(x.result).replace(' (git only)', '') : x.result])),
    ...Object.fromEntries((r.checkov?.summary ?? []).map(s => [`checkov ${s.framework}`, `${s.passed} passed, ${s.failed} failed`])), zizmor_findings:r.zizmor?.total ?? null}),
  'docs/evaluation/deployment-timing/summary.json':r => ({...Object.fromEntries(Object.entries(r.cohorts).map(([k, c]) => [k, `${c.runs} runs, ${c.succeeded} ok, ${c.attempts_succeeded}/${c.attempts} attempts, median ${c.run_s ? Math.round(c.run_s.median) : '—'} s`])),
    ...Object.fromEntries(r.strict.map(c => [`cohort ${c.cloud} ${c.mode} ${c.vector_store} ${c.version}`, `${c.succeeded}/${c.runs}, median ${c.run_s ? Math.round(c.run_s.median) : '—'} s`]))}),
};
function compare(archived, fresh){
  const keys = [...new Set([...Object.keys(archived ?? {}), ...Object.keys(fresh ?? {})])];
  const differences = keys.filter(k => JSON.stringify(archived?.[k]) !== JSON.stringify(fresh?.[k])).map(k => ({key:k, archived:archived?.[k] ?? '(absent)', fresh:fresh?.[k] ?? '(absent)'}));
  return {items:keys.length, matching:keys.length - differences.length, differences};
}
const unitStatuses = file => { const r = read(file); return r ? Object.fromEntries(r.testResults.flatMap(f => f.assertionResults.map(a => [a.fullName, a.status]))) : null; };

// ── Main ─────────────────────────────────────────────────────────────────
function main(){
  const started = now();
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'repro-'));
  const fresh = path.join(work, 'fresh'), logs = path.join(work, 'logs'); fs.mkdirSync(fresh); fs.mkdirSync(logs);
  const {repo, source} = prepare(work);
  // The evidence archived at this commit, read before any step overwrites it.
  const archived = Object.fromEntries(Object.keys(CLAIMS).map(f => [f, read(path.join(repo, f))]));
  const evaluationMd = fs.existsSync(path.join(repo, 'EVALUATION.md')) ? fs.readFileSync(path.join(repo, 'EVALUATION.md'), 'utf8') : '';
  const env = versions(repo);
  log(`node ${env.node}, npm ${env.npm}, ${env.os}; ${withheld} environment variables withheld`);

  const results = [], comparisons = [];
  for(const step of steps(fresh)){
    log(`▶ ${step.title}`);
    const r = run(step, repo, logs);
    results.push(r);
    log(`  ${r.ok ? 'ok' : 'FAILED'} (exit ${r.exit}) in ${r.seconds} s`);
    if(step.id === 'install' && !r.ok) break;
    if(step.result){
      const now_ = read(path.join(repo, step.result));
      const keep = path.join(fresh, `${step.id}.json`); if(now_) fs.writeFileSync(keep, JSON.stringify(now_, null, 2));
      const before = archived[step.result];
      comparisons.push({step:step.id, artefact:step.result, archived_present:Boolean(before), fresh_present:Boolean(now_),
        ...(before && now_ ? compare(CLAIMS[step.result](before), CLAIMS[step.result](now_)) : {items:0, matching:0, differences:[{key:'(file)', archived:before ? 'present' : 'absent', fresh:now_ ? 'present' : 'absent'}]})});
    }
  }

  // Unit tests: each repeat against the first, and the totals EVALUATION.md quotes.
  const unit = Array.from({length:REPEAT}, (_, i) => unitStatuses(path.join(fresh, `unit-${i + 1}.json`)));
  const unitTotals = unit.map(u => u && {total:Object.keys(u).length, passed:Object.values(u).filter(s => s === 'passed').length, failed:Object.values(u).filter(s => s === 'failed').length});
  const flaky = unit.slice(1).map((u, i) => ({repeat:i + 2, ...compare(unit[0], u)}));
  const coverage = read(path.join(fresh, 'coverage', 'coverage-summary.json'))?.total ?? null;
  const quoted = /stands at ([\d.]+)% of lines and\s+([\d.]+)% of branches \((\d+) tests\)/.exec(evaluationMd);
  const unitClaim = quoted && coverage && unitTotals[0] ? {quoted:{lines:+quoted[1], branches:+quoted[2], tests:+quoted[3]}, fresh:{lines:coverage.lines.pct, branches:coverage.branches.pct, tests:unitTotals[0].total},
    matches:+quoted[1] === coverage.lines.pct && +quoted[2] === coverage.branches.pct && +quoted[3] === unitTotals[0].total} : null;
  const lint = read(path.join(fresh, 'lint.json'));

  const allSteps = results.every(r => r.ok);
  const allMatch = comparisons.every(c => !c.differences.length) && flaky.every(f => !f.differences.length) && unitTotals.every(t => t && !t.failed) && (!unitClaim || unitClaim.matches);
  const verdict = allSteps && allMatch ? 'REPRODUCED' : allSteps ? 'RAN, WITH DIFFERENCES' : 'DID NOT COMPLETE';
  const out = {generated:now(), started, verdict, source, environment:env, repeat:REPEAT, steps:results, unit:{runs:unitTotals, repeats:flaky, coverage, against_evaluation_md:unitClaim},
    lint:lint ? {errors:lint.reduce((a, f) => a + f.errorCount, 0), warnings:lint.reduce((a, f) => a + f.warningCount, 0)} : null, comparisons,
    not_reproducible_without_credentials:['S1 and S4 (need live tenants)', 'S5 (needs the hosted platform and its webhook secret)', 'S7 (needs the database)', 'S6 over CI logs (needs a GitHub token)', 'new deployment runs and E1–E10 (need cloud accounts)']};

  fs.mkdirSync(path.join(OUT, 'fresh'), {recursive:true});
  for(const f of fs.readdirSync(fresh).filter(f => f.endsWith('.json') && !f.startsWith('unit-'))) fs.copyFileSync(path.join(fresh, f), path.join(OUT, 'fresh', f));
  if(coverage) fs.writeFileSync(path.join(OUT, 'fresh', 'coverage-summary.json'), JSON.stringify({total:coverage}, null, 2));
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(out, null, 2) + '\n');
  fs.writeFileSync(path.join(OUT, 'REPORT.md'), report(out));
  if(!has('--keep')) fs.rmSync(work, {recursive:true, force:true, maxRetries:3}); else log(`--keep: left ${work}`);
  log(`${verdict}. Wrote docs/evaluation/reproducibility/REPORT.md`);
  process.exitCode = verdict === 'REPRODUCED' ? 0 : 1;
}

function report(o){
  const cell = s => String(s ?? '—').replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const src = o.source;
  const L = ['# Clean reproducibility run', '',
    `Generated ${o.generated} by \`npm run evaluate:reproducibility${src.mode === 'working tree' ? ' -- --working-tree' : src.ref !== 'HEAD' ? ` -- --ref ${src.ref}` : ''}\`. **${o.verdict}.**`, '',
    src.mode === 'commit'
      ? `Reproduced: commit \`${src.commit}\`, cloned fresh. ${src.author_tree_differs_by ? `The author's working tree differed from it by ${src.author_tree_differs_by} files when this ran, so evidence generated in that tree may describe code this commit does not contain.` : 'The author\'s working tree was clean.'}`
      : `Reproduced: the working tree (commit \`${src.commit.slice(0, 12)}\` plus ${src.changed_against_commit} uncommitted changes; ${src.files} files, sha256 \`${src.tree_sha256.slice(0, 16)}\`), copied onto a fresh clone. **A rehearsal**: an examiner can repeat a commit, not a working tree.`, '',
    '## How clean', '',
    `- A fresh \`git clone\` in a temporary directory; dependencies from \`package-lock.json\` (sha256 \`${o.environment.lockfile_sha256.slice(0, 16)}\`) by \`npm ci\`. No \`.env\` file came along (checked).`,
    `- Every step ran with only ${o.environment.env.kept.length} operating-system variables (${o.environment.env.kept.join(', ')}); ${o.environment.env.withheld_count} variables of the author's environment were withheld, so no database URL, GitHub token or cloud credential was available. TZ=UTC.`,
    `- ${o.environment.os}; ${o.environment.cpu}; ${o.environment.memory_gb} GB. Node ${o.environment.node}, npm ${o.environment.npm}, ${o.environment.git}, ${o.environment.bash ?? 'no bash'}, ${o.environment.jq ?? 'no jq'}, Docker ${o.environment.docker ?? 'not available'}; core.autocrlf ${o.environment.core_autocrlf ?? 'unset'}.`,
    `- Docker images used, by id: ${Object.entries(o.environment.docker_images).map(([k, v]) => `\`${k.length > 40 ? `${k.slice(0, 19)}…` : k}\` ${v ? `\`${v.split(' ')[0].slice(7, 19)}\`` : 'absent'}`).join(', ')}. They come from the local Docker cache; the ids pin them.`, '',
    '## Steps', '', '| Step | Exit | Seconds | Command |', '|---|---|---:|---|',
    ...o.steps.map(s => `| ${s.title} | ${s.ok ? s.exit : `**${s.exit}**`} | ${s.seconds} | \`${cell(s.command)}\` |`), '',
    ...o.steps.filter(s => !s.ok).flatMap(s => [`<details><summary>${s.title}: last lines</summary>`, '', '```', s.tail, '```', '', '</details>', '']),
    '## Unit and attack-matrix tests', '',
    `| Run | Tests | Passed | Failed |`, '|---|---:|---:|---:|', ...o.unit.runs.map((t, i) => `| ${i + 1}${i === 0 ? ' (with coverage)' : ''} | ${t?.total ?? '—'} | ${t?.passed ?? '—'} | ${t?.failed ?? '—'} |`), '',
    ...o.unit.repeats.map(f => `Repeat ${f.repeat} against run 1: ${f.differences.length ? `**${f.differences.length} test(s) changed outcome**: ${f.differences.slice(0, 10).map(d => `${cell(d.key)} (${d.archived} → ${d.fresh})`).join('; ')}` : `all ${f.items} tests had the same outcome.`}`), '',
    o.unit.against_evaluation_md ? `EVALUATION.md states ${o.unit.against_evaluation_md.quoted.lines}% of lines, ${o.unit.against_evaluation_md.quoted.branches}% of branches and ${o.unit.against_evaluation_md.quoted.tests} tests; this run measured ${o.unit.against_evaluation_md.fresh.lines}%, ${o.unit.against_evaluation_md.fresh.branches}% and ${o.unit.against_evaluation_md.fresh.tests}. ${o.unit.against_evaluation_md.matches ? 'They agree.' : '**They differ.**'}` : 'Coverage could not be compared with EVALUATION.md.',
    o.lint ? ` ESLint over src: ${o.lint.errors} errors, ${o.lint.warnings} warnings.` : '', '',
    '## Fresh results against the archived evidence', '',
    'Each archived result at this commit was compared, claim by claim, with the one this run produced. Timings and counts that vary by nature are excluded (see `CLAIMS` in the script).', '',
    '| Evaluation | Archived | Claims compared | Matching | Differences |', '|---|---|---:|---:|---|',
    ...o.comparisons.map(c => `| ${o.steps.find(s => s.id === c.step)?.title ?? c.step} | ${c.archived_present ? 'yes' : '**no**'} | ${c.items} | ${c.matching} | ${c.differences.length ? c.differences.slice(0, 6).map(d => `${cell(d.key)}: ${cell(d.archived)} → ${cell(d.fresh)}`).join('; ') + (c.differences.length > 6 ? `; … ${c.differences.length - 6} more` : '') : 'none'} |`), '',
    '## Not reproducible without credentials', '', ...o.not_reproducible_without_credentials.map(x => `- ${x}`), '',
    'These are evidence of a different kind: each was recorded once, from the live system, and its raw data is archived for audit rather than for re-execution.', '',
    '## Reproducing this', '', '```', 'git clone <repository> && cd <repository> && git checkout <commit>', 'npm run evaluate:reproducibility -- --ref <commit> --repeat 2', '```', '',
    'Needs Node, Git (Git Bash on Windows) with jq, and Docker for the last three evaluations (`--skip-docker` leaves them out). The RAG test needs the evaluated backend image locally; see `docs/evaluation/rag-isolation/REPORT.md`.', ''];
  return L.join('\n');
}

main();
