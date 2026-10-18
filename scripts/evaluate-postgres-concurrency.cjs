/* eslint-disable @typescript-eslint/no-require-imports -- Standalone CommonJS evaluation script. */
// PostgreSQL concurrency evaluation (SEC-CONC).
//
//   npm run evaluate:security:concurrency [-- --parallel 25 --rounds 20]
//
// Starts a throwaway PostgreSQL 16 container bound to 127.0.0.1 on a free
// port, runs src/security-concurrency against it, removes the container, and
// writes docs/evaluation/security-concurrency/: REPORT.md and results.json.
// Free and local: the image is pulled once (pgvector/pgvector:pg16, plain
// PostgreSQL 16 with the vector extension available), and nothing reaches a
// cloud.
const fs = require('node:fs'); const path = require('node:path'); const os = require('node:os'); const crypto = require('node:crypto');
const {spawnSync, execSync} = require('node:child_process');
const {keyPatterns} = require('./lib/security-model.cjs');

const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const parallel = Number(option('--parallel', 25)), rounds = Number(option('--rounds', 20));
const image = 'pgvector/pgvector:pg16';
const dir = 'docs/evaluation/security-concurrency'; fs.mkdirSync(dir, {recursive:true});
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'sec-conc-'));
const docker = (...a) => { const r = spawnSync('docker', a, {encoding:'utf8'}); if(r.status !== 0) throw new Error(`docker ${a[0]}: ${r.stderr.trim()}`); return r.stdout.trim(); };

const password = crypto.randomBytes(12).toString('hex');
const name = `sec-conc-${process.pid}`;
console.log(`Starting ${image} …`);
docker('run', '-d', '--rm', '--name', name, '-e', `POSTGRES_PASSWORD=${password}`, '-p', '127.0.0.1::5432', image);
const stop = () => { try { spawnSync('docker', ['rm', '-f', name], {stdio:'ignore'}); } catch { /* already gone */ } };
for(const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { stop(); process.exit(130); });

let exitCode = 1;
try{
  const port = docker('port', name, '5432/tcp').split('\n')[0].split(':').pop();
  // pg_isready over TCP, so the server is accepting connections and not
  // still in its first-start initialisation.
  for(let i = 0; ; i++){
    if(spawnSync('docker', ['exec', name, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres'], {stdio:'ignore'}).status === 0) break;
    if(i > 60) throw new Error('PostgreSQL did not become ready');
    spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},1000)']);
  }
  const serverVersion = docker('exec', name, 'psql', '-U', 'postgres', '-tAc', 'SHOW server_version');
  const isolation = docker('exec', name, 'psql', '-U', 'postgres', '-tAc', 'SHOW default_transaction_isolation');
  console.log(`PostgreSQL ${serverVersion} on 127.0.0.1:${port} (${isolation}); ${parallel} parallel × ${rounds} rounds`);

  const evidenceFile = path.join(work, 'evidence.jsonl'), vitestFile = path.join(work, 'vitest.json');
  spawnSync(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', '--config', 'vitest.concurrency.config.mts',
    '--reporter=default', '--reporter=json', `--outputFile.json=${vitestFile}`], {stdio:'inherit', env:{...process.env,
      CONCURRENCY_DATABASE_URL:`postgres://postgres:${password}@127.0.0.1:${port}/postgres`,
      CONCURRENCY_PARALLEL:String(parallel), CONCURRENCY_ROUNDS:String(rounds), SECURITY_EVIDENCE_FILE:evidenceFile}});

  const vitest = JSON.parse(fs.readFileSync(vitestFile, 'utf8'));
  const records = fs.existsSync(evidenceFile) ? fs.readFileSync(evidenceFile, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
  const secrets = [...new Set(records.filter(r => r.type === 'fixture-secret').map(r => r.value)), password];
  const observations = records.filter(r => r.type === 'observation');
  const leaks = observations.filter(o => { const t = JSON.stringify(o); return secrets.some(s => t.includes(s)) || Object.values(keyPatterns).some(p => p.test(t)); });
  for(const o of leaks) o.actual = '[withheld: contained a secret]';
  const tests = vitest.testResults.flatMap(f => f.assertionResults.map(a => ({name:a.title, status:a.status})));
  const overall = tests.length > 0 && tests.every(t => t.status === 'passed') && observations.every(o => o.held) && leaks.length === 0 ? 'PASS' : 'FAIL';

  const git = cmd => { try { return execSync(cmd, {encoding:'utf8', stdio:['ignore','pipe','ignore']}).trim(); } catch { return ''; } };
  const generated = new Date().toISOString(), commit = git('git rev-parse --short=12 HEAD');
  const environment = {postgres:serverVersion, isolation, image, parallel, rounds, node:process.version, platform:`${os.type()} ${os.release()}`, commit};
  fs.writeFileSync(path.join(dir, 'results.json'), JSON.stringify({generated, overall, environment, leaks:leaks.length,
    observations:observations.map(o => Object.fromEntries(Object.entries(o).filter(([k]) => k !== 'type' && k !== 'scenario'))), tests}, null, 2) + '\n');

  const cell = s => String(s).replace(/\|/g, '\\|');
  fs.writeFileSync(path.join(dir, 'REPORT.md'), [
    '# Concurrency under real PostgreSQL', '',
    `Generated ${generated} by \`npm run evaluate:security:concurrency\` at commit \`${commit}\` with uncommitted changes. PostgreSQL ${serverVersion} (${image}) in a local Docker container, ${isolation}; ${parallel} parallel requests per round, ${rounds} rounds; Node ${process.version}.`, '',
    'SEC-E2E-01 and 03 test these races against PGlite, which runs one statement at a time. Here the platform\'s own code runs against a PostgreSQL server through a connection pool, so simultaneous requests are simultaneous transactions. Only the session, GitHub dispatch and the tenant\'s signer and backend are replaced.', '',
    `**Overall: ${overall}.** Secrets searched for in the evidence: ${secrets.length} plus ${Object.keys(keyPatterns).length} credential patterns; ${leaks.length ? `${leaks.length} record(s) withheld` : 'none found'}.`, '',
    '| | Scenario | Required | Observed | Held |', '|---|---|---|---|---|',
    ...observations.map(o => `| ${o.kind} | ${cell(o.step)} | ${cell(o.expected)} | \`${cell(JSON.stringify(o.actual))}\` | ${o.held ? '✓' : '✗'} |`),
    '',
    '*stoppedByAtomicWrite* counts callbacks that passed the route\'s read check and were refused only by the conditional UPDATE, after waiting for the winner\'s row lock; it is the direct measure that the requests overlapped. The negative control drops the unique index and repeats the redeploy race.', '',
  ].join('\n'));
  console.log(`\n${overall} — wrote ${dir}/REPORT.md and results.json`);
  exitCode = overall === 'PASS' ? 0 : 1;
}finally{
  stop();
  fs.rmSync(work, {recursive:true, force:true});
}
process.exit(exitCode);
