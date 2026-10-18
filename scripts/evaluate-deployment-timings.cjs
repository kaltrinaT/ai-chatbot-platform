/* eslint-disable @typescript-eslint/no-require-imports -- Standalone CommonJS evaluation script. */
// Deployment timings and repeatability (EVALUATION.md §4, E1 and E2).
//
//   node scripts/evaluate-deployment-timings.cjs extract          archive every deploy and teardown run
//   node scripts/evaluate-deployment-timings.cjs watch --tenant <slug> [--runs 10]
//                                                                  record a redeploy campaign as it happens
//   node scripts/evaluate-deployment-timings.cjs report           REPORT.md, summary.json and runs.csv
//
// Every number here comes from what actually ran: GitHub's record of each
// workflow run (when it was queued, when each step started and ended, how it
// concluded) and the platform's deployments table (when Deploy was pressed,
// when the run's final callback arrived). Nothing is dispatched, and nothing
// in a cloud is touched.
//
// Being careful means three things the earlier OIDC report could not do:
//
//   - Runs are grouped by what they ran. A run's configuration version is the
//     workflow file and the Terraform root at the commit it ran, hashed from
//     this repository's history, so runs of different code are never pooled
//     into one distribution. Pooled figures are labelled as such.
//   - Time is split where it is spent: dispatch, GitHub's queue, each stage
//     of the run (images, sign-in, init, plan, provisioning, waits), and the
//     callback back to the platform.
//   - Repeatability is measured, not inferred, on a cohort of runs that share
//     one configuration version, one tenant and identical inputs (`watch`).
//
// GitHub keeps run and step metadata as long as the run exists, but job logs
// for only 90 days, and Terraform's plan counts are only in the logs. So
// `extract` reads each log once, keeps the counts, the vector store and the
// error lines (credentials and account numbers removed), and never stores the
// log itself. The archive only grows: a run whose log has since expired keeps
// what was read from it earlier.
//
// Writes docs/evaluation/deployment-timing/.
const fs = require('node:fs'); const path = require('node:path'); const crypto = require('node:crypto');
const {execFileSync} = require('node:child_process');
const dotenv = require('dotenv'); dotenv.config({path:'.env.local', quiet:true}); dotenv.config({quiet:true});
const {github, jobLog, stageOf, seconds, readLog, redact, repoPath} = require('./lib/github-runs.cjs');

const dir = 'docs/evaluation/deployment-timing'; fs.mkdirSync(dir, {recursive:true});
const ARCHIVE = path.join(dir, 'runs.json'), CAMPAIGNS = path.join(dir, 'campaigns.json');
const [command, ...args] = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const fail = m => { console.error(m); process.exit(1); };
const now = () => new Date().toISOString();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const load = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } };

const WORKFLOWS = [
  {file:'deploy-tenant.yml', cloud:'aws', kind:'deploy'},
  {file:'deploy-tenant-azure.yml', cloud:'azure', kind:'deploy'},
  {file:'destroy-tenant.yml', cloud:'aws', kind:'destroy'},
  {file:'destroy-tenant-azure.yml', cloud:'azure', kind:'destroy'},
];

// ── Configuration version: what a run actually ran ───────────────────────
const git = (...a) => { try { return execFileSync('git', a, {encoding:'utf8', stdio:['ignore', 'pipe', 'ignore']}).trim(); } catch { return null; } };
function configVersion(sha, workflow, cloud){
  const blob = git('rev-parse', `${sha}:.github/workflows/${workflow}`);
  // The AWS root contains the Azure one as a subdirectory; leave it out, so a
  // change to one cloud's Terraform does not split the other's cohort.
  const tree = cloud === 'aws'
    ? git('ls-tree', '-r', sha, '--', 'infra/terraform')?.split('\n').filter(l => !l.includes('infra/terraform/azure/')).join('\n')
    : git('ls-tree', '-r', sha, '--', 'infra/terraform/azure');
  if(!blob || !tree) return {workflow_blob:blob, terraform_tree:null, version:null};
  const terraform = crypto.createHash('sha256').update(tree).digest('hex').slice(0, 12);
  return {workflow_blob:blob.slice(0, 12), terraform_tree:terraform, version:`${blob.slice(0, 7)}+${terraform.slice(0, 7)}`};
}

// ── Database: the platform's side of each run ────────────────────────────
// What a redeploy campaign must hold fixed. Secrets are compared by the ARN
// they live under, never by value.
const INPUT_COLUMNS = ['cloud_provider', 'aws_account_id', 'aws_region', 'deployment_role_arn', 's3_docs_prefix', 'acm_certificate_arn', 'azure_subscription_id', 'azure_tenant_id', 'azure_client_id', 'azure_region',
  'llm_provider', 'llm_model', 'llm_base_url', 'llm_secret_arn', 'vector_store', 'pinecone_secret_arn', 'docs_signer_secret_arn', 'domain', 'chatbot_version', 'config'];
const fingerprint = row => crypto.createHash('sha256').update(JSON.stringify(INPUT_COLUMNS.map(c => row[c] ?? null))).digest('hex').slice(0, 12);
let sqlClient;
function sql(){
  if(!process.env.DATABASE_URL) return null;
  sqlClient ??= require('@neondatabase/serverless').neon(process.env.DATABASE_URL);
  return sqlClient;
}
async function databaseRows(){
  const db = sql(); if(!db) return null;
  return db.query(`SELECT d.id, d.tenant_id, d.kind, d.status, d.chatbot_version AS deployed_version, d.github_run_id, d.started_at, d.finished_at, d.error_message,
    t.slug, t.cloud_provider, t.vector_store, t.created_at AS tenant_created_at, ${INPUT_COLUMNS.map(c => `t.${c}`).join(', ')}
    FROM deployments d JOIN tenants t ON t.id = d.tenant_id ORDER BY d.started_at`);
}

// ── One run, read once ───────────────────────────────────────────────────
async function readRun(run, wf){
  // Every attempt's jobs: a run re-run from GitHub's UI keeps one id, and only
  // its last attempt shows in the run's conclusion, which would hide the
  // attempts that failed before it.
  const all = (await github(`actions/runs/${run.id}/jobs?filter=all&per_page=100`)).jobs;
  const jobs = all.filter(j => j.run_attempt === run.run_attempt);
  const attempts = [...new Set(all.map(j => j.run_attempt))].sort((a, b) => a - b).map(n => {
    const js = all.filter(j => j.run_attempt === n);
    return {attempt:n, conclusion:js.every(j => j.conclusion === 'success') ? 'success' : js.some(j => j.conclusion === 'cancelled') ? 'cancelled' : 'failure',
      started_at:js.map(j => j.started_at).filter(Boolean).sort()[0] ?? null, completed_at:js.map(j => j.completed_at).filter(Boolean).sort().at(-1) ?? null,
      failed_step:js.flatMap(j => j.steps ?? []).find(s => s.conclusion === 'failure')?.name ?? null};
  });
  let log = null, logStatus = 'parsed';
  try{
    const lines = (await Promise.all(jobs.map(j => jobLog(j.id)))).flat();
    log = readLog(lines, jobs.flatMap(j => j.steps ?? []));
    log.image_digests = [...new Set(lines.map(l => /Digest: (sha256:[a-f0-9]{64})/.exec(l.text)?.[1]).filter(Boolean))];
  }catch(error){ logStatus = error.status === 410 ? 'expired' : error.status === 404 ? 'deleted' : `unavailable (${error.message})`; }
  const deploymentId = /\[([0-9a-f-]{36})\]\s*$/.exec(run.display_title ?? '')?.[1] ?? null;
  const slug = /^(?:Deploy|Destroy) (\S+)/.exec(run.display_title ?? '')?.[1] ?? null;
  return {id:String(run.id), workflow:wf.file, cloud:wf.cloud, kind:wf.kind, run_number:run.run_number, run_attempt:run.run_attempt, event:run.event, title:redact(run.display_title ?? ''),
    slug, deployment_id:deploymentId, head_sha:run.head_sha, head_branch:run.head_branch, conclusion:run.conclusion, created_at:run.created_at, run_started_at:run.run_started_at, updated_at:run.updated_at, url:run.html_url,
    ...configVersion(run.head_sha, wf.file, wf.cloud), attempts,
    jobs:jobs.map(j => ({name:j.name, conclusion:j.conclusion, started_at:j.started_at, completed_at:j.completed_at, labels:j.labels ?? [],
      steps:(j.steps ?? []).map(s => ({name:s.name, stage:stageOf(s.name), conclusion:s.conclusion, started_at:s.started_at, completed_at:s.completed_at, seconds:seconds(s.started_at, s.completed_at)}))})),
    log_status:logStatus, log, read_at:now()};
}

// Merge a fresh read into what was archived: never trade log data for an expired log.
const merge = (old, fresh) => !old ? fresh : {...fresh, ...(fresh.log ? {} : {log:old.log, log_status:old.log ? `${fresh.log_status}; read earlier at ${old.read_at}` : fresh.log_status, read_at:old.read_at})};

async function extract(){
  if(!process.env.CHATBOT_REPO_OWNER || !process.env.CHATBOT_REPO_NAME) fail('CHATBOT_REPO_OWNER and CHATBOT_REPO_NAME must be set (see .env)');
  const archive = load(ARCHIVE, {runs:[]});
  const byId = new Map(archive.runs.map(r => [r.id, r]));
  const refresh = args.includes('--refresh');
  for(const wf of WORKFLOWS){
    let runs = [];
    for(let page = 1; ; page++){
      const r = await github(`actions/workflows/${wf.file}/runs?per_page=100&page=${page}`);
      runs = runs.concat(r.workflow_runs); if(runs.length >= r.total_count || !r.workflow_runs.length) break;
    }
    let read = 0;
    for(const run of runs.filter(r => r.status === 'completed')){
      const old = byId.get(String(run.id));
      if(old && !refresh && (old.log || !/^unavailable/.test(old.log_status))) continue;
      byId.set(String(run.id), merge(old, await readRun(run, wf))); read++;
    }
    console.log(`${wf.file.padEnd(26)} ${runs.length} runs, ${read} read now`);
  }
  // The platform's side: who asked, when, and whether the tenant had a successful deploy before.
  const rows = await databaseRows();
  const runs = [...byId.values()].sort((a, b) => a.created_at.localeCompare(b.created_at));
  if(rows){
    for(const r of runs){
      const d = rows.find(x => x.github_run_id === r.id) ?? rows.find(x => x.id === r.deployment_id);
      if(!d){ r.db = null; continue; }
      const earlier = rows.filter(x => x.tenant_id === d.tenant_id && x.kind === 'deploy' && x.status === 'succeeded' && new Date(x.finished_at) < new Date(d.started_at));
      r.db = {deployment_id:d.id, tenant_id:d.tenant_id, slug:d.slug, kind:d.kind, status:d.status, started_at:new Date(d.started_at).toISOString(), finished_at:d.finished_at ? new Date(d.finished_at).toISOString() : null,
        // No input fingerprint here: tenant rows are mutable, so today's row says
        // nothing about what an old run was given. Only `watch` records inputs.
        error:d.error_message ? redact(d.error_message).slice(0, 200) : null, vector_store_now:d.vector_store, deployed_version:d.deployed_version,
        earlier_successful_deploys:earlier.length};
    }
  }
  fs.writeFileSync(ARCHIVE, JSON.stringify({extracted_at:now(), repository:repoPath(), database_joined:Boolean(rows), runs}, null, 2) + '\n');
  console.log(`Archived ${runs.length} runs in ${ARCHIVE}${rows ? '' : ' (no DATABASE_URL: not joined to the platform\'s records)'}`);
}

// ── A redeploy campaign, recorded as it happens ──────────────────────────
// The operator presses Redeploy, waits for this to report the run, and
// presses it again, without changing anything on the tenant in between. Each
// run is archived the moment it finishes, so its log is read while GitHub
// still has it, and the chatbot's /api/health is polled throughout, which
// shows whether a redeploy interrupts the service.
async function watch(){
  const slug = option('--tenant') ?? fail('watch needs --tenant <slug>');
  const want = Number(option('--runs', 10)), every = Number(option('--health-every', 10)) * 1000;
  const db = sql() ?? fail('watch needs DATABASE_URL');
  const [tenant] = await db.query(`SELECT * FROM tenants WHERE slug = $1 AND deleted_at IS NULL`, [slug]);
  if(!tenant) fail(`No live tenant ${slug}`);
  const campaign = {tenant:slug, cloud:tenant.cloud_provider, vector_store:tenant.vector_store, started_at:now(), inputs_at_start:fingerprint(tenant), deployments:[], health:[]};
  const save = () => { const all = load(CAMPAIGNS, []); const i = all.findIndex(c => c.started_at === campaign.started_at); if(i >= 0) all[i] = campaign; else all.push(campaign); fs.writeFileSync(CAMPAIGNS, JSON.stringify(all, null, 2) + '\n'); };
  const health = tenant.chatbot_url ? setInterval(async () => {
    const at = now(), t = performance.now();
    try { const r = await fetch(`${tenant.chatbot_url.replace(/\/$/, '')}/api/health`, {signal:AbortSignal.timeout(8000), redirect:'error'}); campaign.health.push({at, ok:r.status === 200, status:r.status, ms:Math.round(performance.now() - t)}); }
    catch(e){ campaign.health.push({at, ok:false, status:null, error:e.cause?.code ?? e.name}); }
  }, every) : null;
  console.log(`Watching ${slug}. Press Redeploy in the platform now, then again after each run reported here (${want} runs).${health ? '' : ' No chatbot URL recorded, so availability is not probed.'}`);
  const seen = new Set();
  while(campaign.deployments.length < want){
    const deps = await db.query(`SELECT d.*, t.* , d.id AS deployment_id, d.chatbot_version AS deployed_version FROM deployments d JOIN tenants t ON t.id = d.tenant_id
      WHERE t.slug = $1 AND d.started_at >= $2 ORDER BY d.started_at`, [slug, campaign.started_at]);
    for(const d of deps.filter(x => !seen.has(x.deployment_id) && ['succeeded', 'failed', 'cancelled'].includes(x.status))){
      seen.add(d.deployment_id);
      let run = null;
      for(let i = 0; i < 6 && !run; i++){
        try{
          const wf = WORKFLOWS.find(w => w.cloud === d.cloud_provider && w.kind === d.kind);
          const found = d.github_run_id ? await github(`actions/runs/${d.github_run_id}`) : (await github(`actions/workflows/${wf.file}/runs?per_page=30`)).workflow_runs.find(r => r.display_title?.includes(d.deployment_id));
          if(found?.status === 'completed') run = await readRun(found, wf); else await sleep(20000);
        }catch{ await sleep(20000); }
      }
      if(run){ const archive = load(ARCHIVE, {runs:[]}); const i = archive.runs.findIndex(r => r.id === run.id); if(i >= 0) archive.runs[i] = merge(archive.runs[i], run); else archive.runs.push(run); fs.writeFileSync(ARCHIVE, JSON.stringify(archive, null, 2) + '\n'); }
      campaign.deployments.push({deployment_id:d.deployment_id, kind:d.kind, status:d.status, started_at:new Date(d.started_at).toISOString(), finished_at:d.finished_at && new Date(d.finished_at).toISOString(),
        run_id:run?.id ?? d.github_run_id ?? null, version:run?.version ?? null, inputs:fingerprint(d), image_digests:run?.log?.image_digests ?? [], plans:run?.log?.plans ?? []});
      save();
      const n = campaign.deployments.length;
      console.log(`${now()}  run ${n}/${want}: ${d.status}, ${Math.round((new Date(d.finished_at) - new Date(d.started_at)) / 1000)} s; plan ${JSON.stringify(run?.log?.plans ?? [])}${n < want ? ' — press Redeploy again' : ''}`);
    }
    await sleep(15000);
  }
  if(health) clearInterval(health);
  campaign.finished_at = now(); save();
  console.log(`Campaign recorded in ${CAMPAIGNS}. Run \`report\` to analyse it.`);
}

// ── Statistics ───────────────────────────────────────────────────────────
// Quantiles by linear interpolation (Hyndman & Fan type 7, R's default);
// success rates with a Wilson 95% interval, which stays inside [0, 1] for small n.
const quantile = (xs, q) => { const s = [...xs].sort((a, b) => a - b); if(!s.length) return null; const h = (s.length - 1) * q, lo = Math.floor(h); return s[lo] + (h - lo) * (s[Math.min(lo + 1, s.length - 1)] - s[lo]); };
const mean = xs => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
const sd = xs => xs.length > 1 ? Math.sqrt(xs.reduce((a, x) => a + (x - mean(xs)) ** 2, 0) / (xs.length - 1)) : null;
function describe(xs){
  if(!xs.length) return null;
  const m = mean(xs), s = sd(xs);
  return {n:xs.length, median:quantile(xs, 0.5), q1:quantile(xs, 0.25), q3:quantile(xs, 0.75), min:Math.min(...xs), max:Math.max(...xs), mean:m, sd:s, cv:s !== null && m ? s / m : null};
}
function wilson(k, n, z = 1.96){
  if(!n) return null;
  const p = k / n, d = 1 + z * z / n, c = p + z * z / (2 * n), r = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n));
  return [Math.max(0, (c - r) / d), Math.min(1, (c + r) / d)];
}

// What one run's numbers are, from the archive alone.
const STAGE_ORDER = ['queue', 'workflow setup', 'images', 'cloud sign-in', 'terraform init', 'terraform plan', 'terraform apply', 'propagation wait', 'post-apply'];
function measure(r){
  const steps = r.jobs.flatMap(j => j.steps);
  const firstStep = steps.map(s => s.started_at).filter(Boolean).sort()[0] ?? null;
  const lastDone = r.jobs.map(j => j.completed_at).filter(Boolean).sort().at(-1) ?? null;
  // A re-run's created_at is the first attempt's; its queue starts when the attempt does.
  const stages = Object.fromEntries(STAGE_ORDER.map(s => [s, 0])); stages.queue = seconds(r.run_attempt > 1 ? r.run_started_at : r.created_at, firstStep);
  for(const s of steps){
    if(s.seconds === null) continue;
    if(s.stage !== 'terraform apply'){ stages[s.stage] += s.seconds; continue; }
    // Step times are whole seconds and log times are not, so the split is clamped to the step.
    const found = r.log?.planning?.find(p => p.step === s.name)?.planning;
    const plan = found === null || found === undefined ? null : Math.min(Math.max(found, 0), s.seconds);
    if(plan === null) stages['terraform apply'] += s.seconds;
    else { stages['terraform plan'] += plan; stages['terraform apply'] += s.seconds - plan; }
  }
  const failed = steps.find(s => s.conclusion === 'failure');
  // A teardown that found nothing in its state is a different operation from one that removed a deployment.
  const mode = r.kind === 'destroy' ? (r.log?.applies?.[0]?.destroyed === 0 ? 'nothing to destroy' : 'removal')
    : r.db ? (r.db.earlier_successful_deploys ? 'redeploy' : 'first deploy')
    : r.log?.plans?.[0] ? (r.log.plans[0].add === 0 ? 'redeploy (inferred)' : r.log.plans[0].add >= 10 && !r.log.plans[0].destroy ? 'first deploy (inferred)' : 'unknown') : 'unknown';
  return {id:r.id, url:r.url, created_at:r.created_at, cloud:r.cloud, kind:r.kind, mode, version:r.version, slug:r.db?.slug ?? r.slug,
    vector_store:r.log?.vector_store ?? r.db?.vector_store_now ?? null, vector_store_source:r.log?.vector_store ? 'run log' : r.db ? 'tenant now' : null,
    conclusion:r.conclusion, success:r.conclusion === 'success', attempt:r.run_attempt,
    attempts:r.attempts ?? [{attempt:r.run_attempt, conclusion:r.conclusion}],
    run_s:seconds(firstStep, lastDone), queue_s:stages.queue, platform_s:r.db ? seconds(r.db.started_at, r.db.finished_at) : null,
    dispatch_s:r.db ? seconds(r.db.started_at, r.created_at) : null, callback_s:r.db?.finished_at ? seconds(lastDone, r.db.finished_at) : null,
    stages, failed_step:failed?.name ?? null, failed_stage:failed ? (failed.stage === 'terraform apply' ? 'terraform apply' : failed.stage) : null,
    errors:r.log?.errors ?? [], log_status:r.log_status, plans:r.log?.plans ?? [], applies:r.log?.applies ?? [], image_digests:r.log?.image_digests ?? [], db_status:r.db?.status ?? null,
    resources:(r.log?.resources ?? []).filter(x => !x.endsWith(' read during apply'))};
}

// Failure categories, assigned by rule from the error lines and the failed
// step, so the classification can be audited against the raw lines in the appendix.
const CATEGORIES = [
  ['account restriction', /account must be verified|not (?:yet )?(?:verified|activated)|SubscriptionNotRegistered|MissingSubscriptionRegistration|not registered to use namespace/i],
  ['quota or limit', /quota|LimitExceeded|limit exceeded|MaxNumberOf|OverQuota|exceeded the maximum|capacity|Insufficient/i],
  ['credential or permission', /AccessDenied|not authorized|Unauthorized|Forbidden|AuthorizationFailed|AADSTS|InvalidClientTokenId|could not assume|No credentials|ExpiredToken|permission/i],
  ['name collision', /already exists|AlreadyExists|AlreadyOwnedByYou|EntityAlreadyExists|soft.?deleted|ResourceExists|is already in use|Conflict/i],
  ['provider transient', /timed? ?out|connection (?:refused|reset)|ECONNRESET|TooManyRequests|Throttl|\b50[234]\b|temporarily|InternalError|RequestTimeout|i\/o timeout|EOF/i],
];
function category(m){
  if(m.success) return null;
  if(m.conclusion === 'cancelled') return 'cancelled';
  const text = [...m.errors, m.failed_step ?? ''].join('\n');
  if(!m.errors.length) return m.log_status === 'parsed' ? 'unclassified (no error line)' : 'unclassified (log not retained)';
  return CATEGORIES.find(([, re]) => re.test(text))?.[0] ?? 'configuration or platform defect';
}

// ── Report ───────────────────────────────────────────────────────────────
function report(){
  const archive = load(ARCHIVE, null) ?? fail(`No archive yet; run \`extract\` first (${ARCHIVE})`);
  const campaigns = load(CAMPAIGNS, []);
  const runs = archive.runs.map(measure);
  for(const m of runs) m.category = category(m);
  const min = s => s === null || s === undefined ? '—' : (s / 60).toFixed(1);
  const pct = x => x === null ? '—' : `${Math.round(100 * x)}%`;
  const cell = s => String(s ?? '—').replace(/\|/g, '\\|').replace(/\n/g, ' ');
  // The configuration matrix's cells (EVALUATION.md §2): cloud × vector store, per mode.
  const label = m => `${m.cloud.toUpperCase()} ${m.kind === 'destroy' ? `teardown${m.mode === 'nothing to destroy' ? ' (nothing to destroy)' : ''}` : m.mode}${m.vector_store ? ` · ${m.vector_store}` : ''}`;
  const group = (list, key) => list.reduce((g, m) => ((g[key(m)] ??= []).push(m), g), {});
  const ratio = (k, n) => { const ci = wilson(k, n); return `${k}/${n} (${pct(n ? k / n : null)}; 95% CI ${ci ? `${pct(ci[0])}–${pct(ci[1])}` : '—'})`; };
  const rate = list => ratio(list.filter(m => m.success).length, list.length);
  const attemptRate = list => { const a = list.flatMap(m => m.attempts); return ratio(a.filter(x => x.conclusion === 'success').length, a.length); };
  const dist = xs => { const d = describe(xs); return d ? `${min(d.median)} (${min(d.q1)}–${min(d.q3)}); ${min(d.min)}–${min(d.max)}` : '—'; };
  const distS = xs => { const d = describe(xs); return d ? `${Math.round(d.median)} s (${Math.round(d.q1)}–${Math.round(d.q3)}); ${d.min}–${d.max} s` : '—'; };

  const summary = {generated:now(), extracted_at:archive.extracted_at, runs:runs.length, database_joined:archive.database_joined, cohorts:{}, strict:[], campaigns:[]};
  const L = ['# Deployment timings and repeatability', '',
    `Generated ${summary.generated} by \`node scripts/evaluate-deployment-timings.cjs report\` from ${runs.length} workflow runs archived ${archive.extracted_at} (\`runs.json\`)${archive.database_joined ? ', joined to the platform\'s deployments table' : '; not joined to the platform\'s records'}. Every number is from a run that happened; nothing was dispatched for this report.`, '',
    '## Data', '',
    `| | Runs |`, '|---|---:|',
    ...WORKFLOWS.map(w => `| \`${w.file}\` | ${runs.filter(m => m.cloud === w.cloud && m.kind === w.kind).length} |`),
    `| with the platform's record (T0, T5) | ${runs.filter(m => m.platform_s !== null).length} |`,
    `| with the job log read (plan counts, vector store, errors) | ${archive.runs.filter(r => r.log).length} |`,
    `| distinct configuration versions | ${new Set(runs.map(m => `${m.cloud}/${m.kind}/${m.version}`)).size} |`, '',
    'A run\'s **configuration version** is its workflow file and Terraform root at the commit it ran, hashed from this repository\'s history and written `<workflow blob>+<Terraform tree>`; it is not a commit id (`runs.json` has each run\'s commit). Durations are in minutes, given as median (interquartile range); min–max. **Run** is GitHub\'s first step to last job completed; **queue** is the run being created to its first step; **platform** is `T5 − T0` in the deployments table, Deploy pressed to the final callback. Success rates carry a Wilson 95% interval.', ''];

  // 1. Everything, pooled across versions: development history, descriptive only.
  L.push('## 1. All runs, pooled across versions', '', 'Development history: these runs span changing workflows and Terraform, so the spread includes code changes, and the success rate describes the development period, not the final system. A run re-run from GitHub\'s interface keeps one id; **runs** counts its final outcome, **attempts** counts every try. The vector store is the one the run was given (read from its log) or, failing that, the tenant\'s current one; *mode* is from the platform\'s record, or inferred from Terraform\'s first plan where there is none.', '',
    '| Workflow, mode and vector store | Runs | Versions | Runs succeeded | Attempts succeeded | Run (successful) | Queue | Platform T5−T0 (successful) |', '|---|---:|---:|---|---|---|---|---|');
  for(const [k, list] of Object.entries(group(runs, label)).sort()){
    const ok = list.filter(m => m.success);
    summary.cohorts[k] = {runs:list.length, attempts:list.flatMap(m => m.attempts).length, versions:new Set(list.map(m => m.version)).size, succeeded:ok.length, attempts_succeeded:list.flatMap(m => m.attempts).filter(a => a.conclusion === 'success').length,
      run_s:describe(ok.map(m => m.run_s).filter(x => x !== null)), queue_s:describe(list.map(m => m.queue_s).filter(x => x !== null)), platform_s:describe(ok.map(m => m.platform_s).filter(x => x !== null))};
    L.push(`| ${k} | ${list.length} | ${summary.cohorts[k].versions} | ${rate(list)} | ${attemptRate(list)} | ${dist(ok.map(m => m.run_s).filter(x => x !== null))} | ${distS(list.map(m => m.queue_s).filter(x => x !== null))} | ${dist(ok.map(m => m.platform_s).filter(x => x !== null))} |`);
  }
  L.push('');

  // 2. Where the time goes, over every successful run.
  L.push('## 2. Where the time goes', '', 'Median seconds per stage over successful runs, per workflow and mode. Terraform\'s apply step is split at its "Plan:" line into planning and provisioning when the log was read; otherwise all of it counts as provisioning.', '',
    `| Workflow and mode | n | ${STAGE_ORDER.join(' | ')} |`, `|---|---:|${STAGE_ORDER.map(() => '---:').join('|')}|`);
  for(const [k, list] of Object.entries(group(runs.filter(m => m.success), label)).sort()) L.push(`| ${k} | ${list.length} | ${STAGE_ORDER.map(s => { const q = quantile(list.map(m => m.stages[s]).filter(x => x !== null), 0.5); return q === null ? '—' : Math.round(q); }).join(' | ')} |`);
  L.push('');

  // 3. Strict cohorts: same workflow, mode, vector store and configuration version.
  const strict = Object.entries(group(runs.filter(m => m.version && m.kind === 'deploy'), m => `${m.cloud}|${m.mode}|${m.vector_store ?? '?'}|${m.version}`))
    .map(([k, list]) => ({key:k, list, ok:list.filter(m => m.success)})).filter(c => c.list.length >= 2)
    .sort((a, b) => a.key.includes('|unknown|') - b.key.includes('|unknown|') || b.ok.length - a.ok.length || b.list.length - a.list.length);
  L.push('## 3. Repeatability: runs of one configuration version', '', 'Only runs that ran identical code are compared: same cloud, mode, vector store and configuration version, with at least two runs. The coefficient of variation (CV, SD ÷ mean) of successful run times is the repeatability measure. *Resources planned* lists each distinct plan (add/change/destroy) among the successful runs: one value means the same code created the same resource set, and a smaller add count marks a retry that found part of a deployment already there. Whether these runs were also given identical inputs cannot be told after the fact, since tenant rows are mutable; the campaign in §5 records that.', '',
    '| Cloud | Mode | Vector store | Version | Runs | Succeeded | Run (successful) | CV | Tenants | Resources planned (successful) | Distinct resource sets | Image digests |', '|---|---|---|---|---:|---|---|---:|---:|---|---:|---:|');
  for(const c of strict){
    const [cloud, mode, store, version] = c.key.split('|');
    const d = describe(c.ok.map(m => m.run_s).filter(x => x !== null));
    // The same code creating the same number of resources is E2's "equivalent resource set", as far as a plan can show it.
    // Every plan of the run in order: Azure applies twice, a targeted apply and then the rest.
    const planned = [...new Set(c.ok.map(m => m.plans.length ? m.plans.map(p => `+${p.add}/~${p.change}/−${p.destroy}`).join(' then ') : null).filter(Boolean))];
    // The resource addresses each successful run planned, compared as a whole: one set means identical infrastructure.
    const sets = new Set(c.ok.filter(m => m.resources.length).map(m => m.resources.join('\n')));
    summary.strict.push({cloud, mode, vector_store:store, version, runs:c.list.length, succeeded:c.ok.length, run_s:d, tenants:new Set(c.list.map(m => m.slug)).size, planned, resource_sets:sets.size});
    L.push(`| ${cloud} | ${mode} | ${store} | \`${version}\` | ${c.list.length} | ${rate(c.list)} | ${dist(c.ok.map(m => m.run_s).filter(x => x !== null))} | ${d?.cv !== null && d?.cv !== undefined ? d.cv.toFixed(2) : '—'} | ${new Set(c.list.map(m => m.slug)).size} | ${planned.join(', ') || '—'} | ${sets.size || '—'} | ${new Set(c.list.flatMap(m => m.image_digests)).size || '—'} |`);
  }
  if(!strict.length) L.push('| — | | | | | | | | | | | |');
  L.push('', strict.some(c => c.ok.length >= 5) ? '' : '**No configuration version has five or more successful runs, so no repeatability figure here is more than anecdotal.** The redeploy campaign (§5) is how to obtain one.', '');

  // 4. Idempotency of redeploys, from Terraform's own plan.
  const redeploys = runs.filter(m => m.kind === 'deploy' && m.mode.startsWith('redeploy') && m.plans.length);
  L.push('## 4. What a redeploy changes, and what a teardown removes', '', `Terraform's plan in every redeploy whose log was read (${redeploys.length} runs). An idempotent redeploy plans no change.`, '',
    '| Run | Cloud | Tenant | Version | Same version as the deploy before it | Plans (add/change/destroy) | No change | What the plan touched | Succeeded |', '|---|---|---|---|---|---|---|---|---|',
    ...redeploys.map(m => {
      const before = runs.filter(d => d.kind === 'deploy' && d.success && d.slug === m.slug && d.created_at < m.created_at).at(-1);
      return `| [${m.id}](${m.url}) | ${m.cloud} | ${m.slug ?? '—'} | \`${m.version}\` | ${before ? (before.version === m.version ? 'yes' : 'no') : '—'} | ${m.plans.map(p => `${p.add}/${p.change}/${p.destroy}`).join(', ')} | ${m.plans.every(p => !p.add && !p.change && !p.destroy) ? 'yes' : 'no'} | ${cell(m.resources.join(', ')) || '—'} | ${m.success ? 'yes' : 'no'} |`;
    }), '');
  if(!redeploys.length) L.push('No redeploy log was available.', '');
  const teardowns = runs.filter(m => m.kind === 'destroy');
  // What the same tenant's earlier deploys planned to add, to set beside what its teardown removed.
  const createdBefore = m => runs.filter(d => d.kind === 'deploy' && d.slug && d.slug === m.slug && d.created_at < m.created_at && d.plans.length)
    .map(d => `${d.success ? '' : '(failed) '}${d.plans.map(p => `+${p.add}`).join('/')}`);
  L.push('A teardown\'s duration follows what it has to remove, so each is listed with Terraform\'s count of resources destroyed, beside what the same tenant\'s earlier deploys planned to add (from their logs, where retained). A teardown that destroys fewer resources than were created has left the difference to be removed some other way, or behind; only an inventory of the account (E4) can say which.', '',
    '| Run | Cloud | Tenant | Vector store | Version | Resources destroyed | Its deploys planned | Attempts | Run |', '|---|---|---|---|---|---:|---|---|---:|',
    ...teardowns.map(m => `| [${m.id}](${m.url}) | ${m.cloud} | ${m.slug ?? '—'} | ${m.vector_store ?? '—'} | \`${m.version}\` | ${m.applies[0]?.destroyed ?? '—'} | ${createdBefore(m).join(', ') || '—'} | ${m.attempts.map(a => a.conclusion).join(' → ')} | ${min(m.run_s)} |`), '');

  // 5. Campaigns.
  L.push('## 5. Redeploy campaigns', '');
  if(!campaigns.length) L.push('None recorded yet. Protocol: `docs/evaluation/live/RUNBOOK.md`, *Repeatability campaign*.', '');
  for(const c of campaigns){
    const ms = c.deployments.map(d => runs.find(m => m.id === String(d.run_id))).filter(Boolean);
    const ok = ms.filter(m => m.success), d = describe(ok.map(m => m.run_s).filter(x => x !== null));
    const outages = []; let current = null;
    for(const h of c.health){ if(!h.ok){ current ??= {from:h.at, samples:0}; current.samples++; current.to = h.at; } else if(current){ outages.push(current); current = null; } }
    if(current) outages.push(current);
    const sameInputs = new Set([c.inputs_at_start, ...c.deployments.map(x => x.inputs)]).size === 1;
    const versions = new Set(c.deployments.map(x => x.version)), digests = new Set(c.deployments.flatMap(x => x.image_digests));
    const entry = {tenant:c.tenant, cloud:c.cloud, vector_store:c.vector_store, started_at:c.started_at, finished_at:c.finished_at ?? null, runs:c.deployments.length, succeeded:c.deployments.filter(x => x.status === 'succeeded').length,
      run_s:d, identical_inputs:sameInputs, versions:versions.size, image_digests:digests.size, no_change_plans:c.deployments.filter(x => x.plans.length && x.plans.every(p => !p.add && !p.change && !p.destroy)).length,
      health:{samples:c.health.length, failed:c.health.filter(h => !h.ok).length, outages:outages.length, longest_outage_samples:Math.max(0, ...outages.map(o => o.samples))}};
    summary.campaigns.push(entry);
    L.push(`### ${c.tenant} (${c.cloud}, ${c.vector_store}), ${c.started_at}`, '',
      `| | |`, '|---|---|', `| Runs | ${entry.runs} (${entry.succeeded} succeeded; ${rate(ms)}) |`, `| Run time (successful) | ${dist(ok.map(m => m.run_s).filter(x => x !== null))}; CV ${d?.cv?.toFixed(2) ?? '—'} |`,
      `| Platform T5−T0 (successful) | ${dist(ok.map(m => m.platform_s).filter(x => x !== null))} |`, `| Queue | ${dist(ms.map(m => m.queue_s).filter(x => x !== null))} |`,
      `| Inputs identical throughout | ${sameInputs ? 'yes' : '**no**'} |`, `| Configuration versions | ${versions.size}${versions.size > 1 ? ' (**the code changed during the campaign**)' : ''} |`, `| Backend/frontend image digests seen | ${digests.size || 'not in logs'} |`,
      `| Redeploys planning no change | ${entry.no_change_plans}/${entry.runs} |`, `| /api/health samples failed | ${entry.health.failed}/${entry.health.samples}; ${outages.length} outage(s), longest ${entry.health.longest_outage_samples} consecutive sample(s) |`, '',
      `| # | Status | Run | Platform T5−T0 | Queue | Plan |`, '|---:|---|---|---|---|---|',
      ...c.deployments.map((x, i) => { const m = runs.find(r => r.id === String(x.run_id)); return `| ${i + 1} | ${x.status} | ${m ? `[${min(m.run_s)}](${m.url})` : '—'} | ${min(m?.platform_s)} | ${min(m?.queue_s)} | ${x.plans.map(p => `${p.add}/${p.change}/${p.destroy}`).join(', ') || '—'} |`; }), '');
  }

  // 6. Failures.
  const failures = runs.filter(m => !m.success);
  const cats = group(failures, m => m.category);
  L.push('## 6. Why runs failed', '', 'Assigned by rule (`CATEGORIES` in the script) from the error lines and the failed step; the lines themselves are in the appendix so each assignment can be checked.', '',
    '| Category | Runs | Failed stage (count) |', '|---|---:|---|',
    ...Object.entries(cats).sort((a, b) => b[1].length - a[1].length).map(([k, list]) => `| ${k} | ${list.length} | ${Object.entries(group(list, m => m.failed_stage ?? '—')).map(([s, l]) => `${s} (${l.length})`).join(', ')} |`), '');

  // 7. Consistency.
  const joined = runs.filter(m => m.db_status);
  const disagree = joined.filter(m => (m.db_status === 'succeeded') !== m.success && m.db_status !== 'running' && m.db_status !== 'pending');
  L.push('## 7. Consistency of the two records', '',
    `${joined.length} runs have a platform record. Their outcome disagrees with GitHub's conclusion in ${disagree.length}${disagree.length ? ` (${disagree.map(m => `[${m.id}](${m.url})`).join(', ')})` : ''}. From Deploy pressed (T0) to GitHub creating the run: ${distS(joined.map(m => m.dispatch_s).filter(x => x !== null))}. T5 relative to the run's last job completing: ${distS(joined.map(m => m.callback_s).filter(x => x !== null))}; negative because the success callback is itself a step of the job, so T5 is recorded before the job's own clean-up ends. T5 − T0 and GitHub's run time therefore differ by little more than the queue, and either can stand for the workflow\'s duration.`, '',
    'What T5 − T0 does not include: the time from the run\'s success to a healthy chatbot (T6) and to its first grounded answer (T7). Those need a live probe: `node scripts/evaluate-live.cjs readiness`.', '');

  // Appendix.
  L.push('## Appendix: every run', '', '<details><summary>Runs, oldest first</summary>', '',
    '| Run | Created | Workflow and mode | Version | Vector store | Conclusion | Run | Queue | Platform | Failed step | Category | Error |', '|---|---|---|---|---|---|---:|---:|---:|---|---|---|',
    ...runs.map(m => `| [${m.id}](${m.url}) | ${m.created_at.slice(0, 16)} | ${label(m)} | \`${m.version ?? '?'}\` | ${m.vector_store ?? '—'} | ${m.conclusion} | ${min(m.run_s)} | ${min(m.queue_s)} | ${min(m.platform_s)} | ${cell(m.failed_step)} | ${m.category ?? ''} | ${cell(m.errors[0]?.slice(0, 140))} |`),
    '', '</details>', '', '## Reproducing', '',
    '`node scripts/evaluate-deployment-timings.cjs extract` (needs `GITHUB_PAT`, `CHATBOT_REPO_OWNER`, `CHATBOT_REPO_NAME`, and `DATABASE_URL` for the join; read-only), then `… report`. `runs.json` is the archive; it only grows, and keeps what was read from logs GitHub has since expired.', '');
  fs.writeFileSync(path.join(dir, 'REPORT.md'), L.join('\n'));
  fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  const cols = ['id', 'created_at', 'cloud', 'kind', 'mode', 'version', 'vector_store', 'conclusion', 'run_s', 'queue_s', 'platform_s', 'dispatch_s', 'callback_s', ...STAGE_ORDER.map(s => `stage:${s}`), 'failed_stage', 'category', 'url'];
  const csv = v => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  fs.writeFileSync(path.join(dir, 'runs.csv'), [cols.join(','), ...runs.map(m => cols.map(c => csv(c.startsWith('stage:') ? m.stages[c.slice(6)] : m[c])).join(','))].join('\n') + '\n');
  console.log(`Wrote ${dir}/REPORT.md, summary.json and runs.csv (${runs.length} runs, ${strict.length} same-version cohorts, ${campaigns.length} campaign(s))`);
}

const commands = {extract, watch, report};
if(!commands[command]) fail(`Usage: node scripts/evaluate-deployment-timings.cjs <${Object.keys(commands).join('|')}>; see the header of this file.`);
Promise.resolve(commands[command]()).catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
