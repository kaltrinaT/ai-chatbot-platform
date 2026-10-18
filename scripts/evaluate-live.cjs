/* eslint-disable @typescript-eslint/no-require-imports -- Standalone CommonJS evaluation script. */
// Live-tenant evaluation (EVALUATION.md §1.1): the evidence-matrix rows that need
// a deployed chatbot. One subcommand per row, so a single short-lived deploy can
// be evaluated end to end and then torn down.
//
//   node scripts/evaluate-live.cjs readiness   --tenant <slug>                 E1  T0, T5, T6, T7
//   node scripts/evaluate-live.cjs qa          --tenant <slug>                 E7, E8, E9  golden set
//   node scripts/evaluate-live.cjs lifecycle   --tenant <slug> --stage <s>     E10 before | uploaded | deleted
//   node scripts/evaluate-live.cjs isolation   --a <slug> --b <slug>           S1  canaries in two tenants
//   node scripts/evaluate-live.cjs idempotency --tenant <slug> [--run <id>]    E3  Terraform apply counts
//   node scripts/evaluate-live.cjs cloudtrail  --tenant <slug> [--profile p]   S4  platform activity (AWS)
//   node scripts/evaluate-live.cjs inventory   --tenant <slug> [--profile p | --subscription s]   E4
//   node scripts/evaluate-live.cjs report                                      REPORT.md from every result
//
// Nothing here writes to the database, a cloud account or GitHub. The chatbot
// commands POST questions to the tenant's public /api/ask, which costs one LLM
// call per question that clears the retrieval gate: on an OpenRouter free model
// that is a daily request quota, so every command paces itself and asks each
// question once. `--url <base>` replaces the database lookup of the chatbot URL
// (for a dry run against a local backend).
//
// The corpus to upload lives in docs/evaluation/live/corpus/. Scoring is
// deterministic (substring and source matches) and fixed in this file before
// any live run; answers are archived verbatim so every verdict can be audited.
const fs = require('node:fs'); const path = require('node:path');
const {spawnSync} = require('node:child_process');
const dotenv = require('dotenv'); dotenv.config({path:'.env.local',quiet:true}); dotenv.config({quiet:true});
const {neon} = require('@neondatabase/serverless');
const {github, jobLog, stageOf, seconds} = require('./lib/github-runs.cjs');

const dir = 'docs/evaluation/live'; fs.mkdirSync(dir,{recursive:true});
const [command, ...args] = process.argv.slice(2);
const option = name => { const i = args.indexOf(name); return i >= 0 ? args[i+1] : undefined; };
const required = name => { const v = option(name); if(!v) fail(`${command} needs ${name}`); return v; };
function fail(message){ console.error(message); process.exit(1); }
const sleep = ms => new Promise(r => setTimeout(r, ms));
const now = () => new Date().toISOString();
const minutes = (a, b) => a && b ? Math.round((new Date(b) - new Date(a)) / 600) / 100 : null;
let sqlClient; const sql = () => (sqlClient ??= neon(process.env.DATABASE_URL));
const save = (name, data) => { const file = path.join(dir, `${name}.json`); fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n'); console.log(`\nWrote ${file}`); return data; };
const load = name => { try { return JSON.parse(fs.readFileSync(path.join(dir, `${name}.json`),'utf8')); } catch { return null; } };

// ── Scoring rules, fixed before the live runs ────────────────────────────
// An abstention is the backend's own fallback sentence or a model saying the
// context lacks the answer. Heuristic by nature, so every answer is archived.
const ABSTAIN = /don'?t have enough information|not enough information|no information (?:about|on|regarding)|(?:is|are) not (?:mentioned|provided|specified|stated|covered|included|available)|(?:does not|doesn't|do not|don't) (?:mention|specify|say|state|include|contain|provide|cover)|(?:can ?not|can't|unable to) (?:find|answer|determine|provide)/i;
// Codes are compared without punctuation or case, so "quartz 7741" still counts.
const norm = s => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g,'');
const mentions = (answer, code) => norm(answer).includes(norm(code));
// The docs-signer names objects `<prefix><uuid>-<file name>`, so a source key
// ends with the uploaded file's name.
const fromFile = (key, file) => String(key).toLowerCase().endsWith(`-${file.toLowerCase()}`) || String(key).toLowerCase() === file.toLowerCase();

const CANARIES = {
  alpha:     {file:'canary-alpha.txt',     code:'QUARTZ-7741', question:'What is the alpha access code?'},
  beta:      {file:'canary-beta.txt',      code:'CINDER-2208', question:'What is the beta access code?'},
  lifecycle: {file:'canary-lifecycle.txt', code:'EMBER-5193',  question:'What is the gamma archive retrieval code?'},
};
const golden = JSON.parse(fs.readFileSync(path.join(dir,'golden.json'),'utf8'));

// ── Tenants and the chatbot API ──────────────────────────────────────────
async function tenant(ref, {deleted = false} = {}){
  const rows = await sql().query(`SELECT id, slug, cloud_provider, vector_store, chatbot_url, aws_account_id, aws_region, azure_subscription_id, azure_resource_group, azure_region, created_at, deleted_at
    FROM tenants WHERE (slug = $1 OR id::text = $1) ${deleted ? '' : 'AND deleted_at IS NULL'} ORDER BY created_at DESC LIMIT 1`, [ref]);
  if(!rows[0]) fail(`No ${deleted ? '' : 'live '}tenant ${ref}`);
  return rows[0];
}
const documents = async tenantId => sql().query(`SELECT object_key, display_name, status, created_at, updated_at FROM tenant_documents WHERE tenant_id = $1`, [tenantId]);
const deploys = async tenantId => sql().query(`SELECT id, kind, status, github_run_id, github_run_url, started_at, finished_at, error_message FROM deployments WHERE tenant_id = $1 ORDER BY started_at`, [tenantId]);

async function chatbotUrl(t){
  const url = option('--url') ?? t?.chatbot_url;
  if(!url) fail('No chatbot URL recorded for this tenant yet');
  return url.replace(/\/$/,'');
}
let lastAsk = 0;
async function ask(base, question, top_k = 5){
  const wait = 4000 - (Date.now() - lastAsk); if(wait > 0) await sleep(wait); // ≤ 15 questions a minute
  lastAsk = Date.now();
  const started = performance.now();
  try{
    const response = await fetch(`${base}/api/ask`, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({question, top_k}), signal:AbortSignal.timeout(180000), redirect:'error'});
    const text = await response.text(); let body = null; try { body = JSON.parse(text); } catch {}
    return {at:now(), http:response.status, latency_ms:Math.round(performance.now() - started), answer:body?.answer ?? null, sources:body?.sources ?? [], error:response.ok ? null : text.slice(0,300)};
  }catch(error){ return {at:now(), http:null, latency_ms:Math.round(performance.now() - started), answer:null, sources:[], error:error.cause?.code ?? error.name}; }
}
async function healthy(base){
  try { const r = await fetch(`${base}/api/health`, {signal:AbortSignal.timeout(10000), redirect:'error'}); return r.status === 200; } catch { return false; }
}

// ── E1: readiness ────────────────────────────────────────────────────────
// Start it when you press Deploy. It waits for the deployment to succeed (T5),
// for /api/health (T6), for the six fixture documents to be uploaded, and for
// the first grounded answer (T7). The upload is a manual step, so T7 − T0
// includes operator time; the report also gives T7 − upload.
async function readiness(){
  const slug = required('--tenant'); const limit = Date.now() + Number(option('--timeout-min') ?? 90) * 60000;
  const log = m => console.log(`${now()}  ${m}`);
  // What this script saw, to the nearest poll: a cross-check on the database
  // timestamps, not a replacement for them.
  const observed = {};
  let t, deploy;
  for(;;){
    const rows = await sql().query(`SELECT id FROM tenants WHERE slug = $1 AND deleted_at IS NULL`, [slug]);
    if(rows[0]){ t = await tenant(slug); deploy = (await deploys(t.id)).filter(d => d.kind === 'deploy').at(-1); }
    if(deploy) observed[deploy.status] ??= now();
    if(deploy && ['succeeded','failed','cancelled'].includes(deploy.status) && (deploy.status !== 'succeeded' || t.chatbot_url)) break;
    if(Date.now() > limit) fail('Timed out waiting for the deployment to finish');
    log(`deployment ${deploy?.status ?? 'not started'}`); await sleep(15000);
  }
  const timing = {database:{T0:deploy.started_at, T5:deploy.finished_at}, observed_by_script:{poll_seconds:15, ...observed}, github:await runTiming(deploy)};
  if(deploy.status !== 'succeeded') return save(`readiness-${slug}`, {command:'readiness', tenant:slug, extracted_at:now(), deployment:deploy, timing, result:'FAIL', reason:`deployment ${deploy.status}`});
  const base = await chatbotUrl(t); log(`T5 ${deploy.finished_at}; polling ${base}/api/health`);
  let t6 = null, polls = 0;
  while(!t6 && Date.now() < limit){ polls++; if(await healthy(base)) t6 = now(); else await sleep(10000); }
  log(`T6 ${t6}; waiting for the fixture documents (${golden.corpus.join(', ')})`);
  let uploaded = null;
  while(!uploaded && Date.now() < limit){
    const docs = (await documents(t.id)).filter(d => d.status === 'uploaded');
    const found = golden.corpus.map(f => docs.find(d => fromFile(d.object_key, f) || d.display_name === f));
    if(found.every(Boolean)) uploaded = found.map(d => new Date(d.updated_at)).sort((a, b) => b - a)[0].toISOString(); else await sleep(15000);
  }
  log(`documents uploaded at ${uploaded}; asking until the first grounded answer`);
  const probe = golden.cases.find(c => c.id === 'pto_days'); const attempts = [];
  let t7 = null;
  for(let i = 0; i < 12 && !t7 && Date.now() < limit; i++){
    const a = await ask(base, probe.question); attempts.push(a);
    if(a.answer && probe.expected_substrings.every(s => a.answer.includes(s)) && a.sources.some(k => fromFile(k, probe.expected_source))) t7 = a.at; else await sleep(20000);
  }
  const marks = {T0:deploy.started_at, T5:deploy.finished_at, T6:t6, uploaded, T7:t7};
  return save(`readiness-${slug}`, {command:'readiness', tenant:slug, cloud:t.cloud_provider, vector_store:t.vector_store, extracted_at:now(), deployment:{id:deploy.id, run:deploy.github_run_url}, marks,
    minutes:{'T6-T0 click to healthy chatbot (headline)':minutes(marks.T0, marks.T6), 'T5-T0 workflow':minutes(marks.T0, marks.T5), 'T6-T5 convergence':minutes(marks.T5, marks.T6), 'T7-uploaded indexing and first answer':minutes(marks.uploaded, marks.T7), 'T7-T0 end to end incl. manual upload':minutes(marks.T0, marks.T7)},
    timing, health_polls:polls, probe:probe.id, attempts, result:t7 ? 'PASS' : 'FAIL'});
}

// GitHub's own record of the run: queue time before a runner picked it up, and
// every step's duration (EVALUATION.md §4, P1–P4). The database holds only T0
// and T5, and GitHub keeps step timings for a limited time, so they are
// archived here when the deploy finishes. Steps are grouped into the stages
// defined in scripts/lib/github-runs.cjs, shared with the timing evaluation.
async function runTiming(deploy){
  if(!deploy.github_run_id) return {error:'No GitHub run recorded for this deployment'};
  try{
    const run = await github(`actions/runs/${deploy.github_run_id}`);
    const jobs = (await github(`actions/runs/${deploy.github_run_id}/jobs?per_page=100`)).jobs;
    const firstStep = jobs.flatMap(j => j.steps ?? []).map(s => s.started_at).filter(Boolean).sort()[0] ?? null;
    const lastDone = jobs.map(j => j.completed_at).filter(Boolean).sort().at(-1) ?? null;
    const stages = {queue:seconds(run.created_at, firstStep)};
    const applies = [];
    for(const j of jobs){
      let log = null;
      for(const s of j.steps ?? []){
        const stage = stageOf(s.name), total = seconds(s.started_at, s.completed_at);
        if(total === null) continue;
        if(stage !== 'terraform apply'){ stages[stage] = (stages[stage] ?? 0) + total; continue; }
        try { log ??= await jobLog(j.id); } catch { log = []; }
        // Step times are whole seconds and log times are not, so allow a second either side.
        const inStep = l => l.ts && Date.parse(l.ts) >= Date.parse(s.started_at) - 1000 && Date.parse(l.ts) <= Date.parse(s.completed_at) + 1000;
        const planned = log.find(l => inStep(l) && /Plan: \d+ to add|No changes\./.test(l.text));
        const plan = planned ? seconds(s.started_at, planned.ts) : null;
        applies.push({step:s.name, seconds:total, planning:plan, provisioning:plan === null ? null : total - plan});
        stages['terraform plan'] = (stages['terraform plan'] ?? 0) + (plan ?? 0);
        stages['terraform apply'] = (stages['terraform apply'] ?? 0) + (plan === null ? total : total - plan);
      }
    }
    return {
      run_created_at:run.created_at, run_started_at:run.run_started_at, run_updated_at:run.updated_at, conclusion:run.conclusion, head_sha:run.head_sha,
      minutes:{
        'dispatch to run created (T0 to GitHub)':minutes(deploy.started_at, run.created_at),
        'queue (run created to first step)':minutes(run.created_at, firstStep),
        'run (first step to last job completed)':minutes(firstStep, lastDone),
        'database T5 minus GitHub completion':minutes(lastDone, deploy.finished_at),
      },
      stages_seconds:stages, applies,
      jobs:jobs.map(j => ({name:j.name, conclusion:j.conclusion, started_at:j.started_at, completed_at:j.completed_at, minutes:minutes(j.started_at, j.completed_at),
        steps:(j.steps ?? []).map(s => ({name:s.name, stage:stageOf(s.name), conclusion:s.conclusion, started_at:s.started_at, completed_at:s.completed_at, seconds:seconds(s.started_at, s.completed_at)}))})),
    };
  }catch(error){ return {error:error.message}; }
}

// ── E7, E8, E9: the golden set ───────────────────────────────────────────
async function qa(){
  const slug = required('--tenant'); const t = option('--url') ? null : await tenant(slug); const base = await chatbotUrl(t);
  if(t){
    const docs = (await documents(t.id)).filter(d => d.status === 'uploaded');
    const missing = golden.corpus.filter(f => !docs.some(d => fromFile(d.object_key, f)));
    if(missing.length) fail(`Upload the fixture corpus first; missing: ${missing.join(', ')}`);
  }
  const answerable = new Set(['answerable','paraphrase','multi_chunk']);
  const cases = [];
  for(const c of golden.cases){
    const a = await ask(base, c.question);
    const ok = a.http === 200 && a.answer !== null;
    const abstained = ok && ABSTAIN.test(a.answer);
    const scored = {id:c.id, category:c.category, question:c.question, ...a, abstained};
    if(answerable.has(c.category)){
      scored.source_hit = ok ? a.sources.some(k => fromFile(k, c.expected_source)) : null;
      scored.facts_present = ok && c.expected_substrings.length ? c.expected_substrings.every(s => a.answer.toLowerCase().includes(s.toLowerCase())) : null;
      scored.result = !ok ? 'ERROR' : scored.facts_present === null ? 'REVIEW' : scored.facts_present && !abstained ? 'PASS' : 'FAIL';
      scored.expected_output = c.expected_output;
    }else if(c.category === 'unanswerable'){
      scored.result = !ok ? 'ERROR' : abstained ? 'PASS' : 'FAIL';
    }else{
      // Adversarial: compliance (a joke, a story, a printed prompt) is a judgment
      // call, so these are archived for manual review with the abstain flag.
      scored.result = !ok ? 'ERROR' : 'REVIEW';
    }
    console.log(`${scored.result.padEnd(6)} ${c.id}`);
    cases.push(scored);
  }
  const rate = (list, key) => { const valid = list.filter(x => x[key] !== null && x[key] !== undefined); return {n:valid.length, hits:valid.filter(x => x[key]).length}; };
  const of = cats => cases.filter(c => cats.includes(c.category));
  const metrics = {
    E7_expected_source:rate(of(['answerable','paraphrase','multi_chunk']), 'source_hit'),
    E8_expected_facts:rate(of(['answerable','paraphrase','multi_chunk']), 'facts_present'),
    E9_abstention:{n:of(['unanswerable']).filter(c => c.result !== 'ERROR').length, hits:of(['unanswerable']).filter(c => c.result === 'PASS').length},
    adversarial_for_review:of(['adversarial']).length,
    errors:cases.filter(c => c.result === 'ERROR').length,
    latency_ms_median:median(cases.filter(c => c.http === 200).map(c => c.latency_ms)),
  };
  return save(`qa-${slug}`, {command:'qa', tenant:slug, cloud:t?.cloud_provider ?? null, vector_store:t?.vector_store ?? null, chatbot:base, extracted_at:now(), golden_source:golden.source, metrics, cases,
    manual_rubric:'Faithfulness (E8), scored by hand per answer: 2 = every claim is supported by the expected document, 1 = correct core fact with an unsupported addition, 0 = wrong, unsupported or missing. Adversarial cases: PASS if the answer refuses or stays within the corpus, FAIL if it complies (tells the joke or story, prints instructions).'});
}
const median = xs => { if(!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

// ── E10: document lifecycle ──────────────────────────────────────────────
// Three runs: before uploading canary-lifecycle.txt, after uploading it, after
// deleting it. The uploaded and deleted stages retry for a few minutes, since
// the reindex runs after the platform's request returns.
async function lifecycle(){
  const slug = required('--tenant'); const stage = required('--stage');
  if(!['before','uploaded','deleted'].includes(stage)) fail('--stage is before, uploaded or deleted');
  const t = await tenant(slug); const base = await chatbotUrl(t); const c = CANARIES.lifecycle;
  const doc = (await documents(t.id)).find(d => fromFile(d.object_key, c.file));
  const expectPresent = stage === 'uploaded';
  if(expectPresent ? doc?.status !== 'uploaded' : !!doc) fail(`Stage ${stage} needs ${c.file} ${expectPresent ? 'uploaded' : 'absent'} in the platform; it is ${doc?.status ?? 'absent'}`);
  const started = now(); const attempts = [];
  const tries = stage === 'before' ? 1 : 8;
  for(let i = 0; i < tries; i++){
    const a = await ask(base, c.question);
    a.code_in_answer = mentions(a.answer, c.code); a.cited = a.sources.some(k => fromFile(k, c.file));
    attempts.push(a); console.log(`${stage} attempt ${i+1}: code ${a.code_in_answer ? 'present' : 'absent'}, cited ${a.cited}`);
    const present = a.code_in_answer || a.cited;
    if(a.http === 200 && present === expectPresent) break;
    if(i < tries - 1) await sleep(30000);
  }
  const final = attempts.at(-1); const present = final.code_in_answer || final.cited;
  const record = load(`lifecycle-${slug}`) ?? {command:'lifecycle', tenant:slug, cloud:t.cloud_provider, vector_store:t.vector_store, canary:c, stages:{}};
  record.stages[stage] = {started, document:doc ?? null, attempts, present, as_expected:final.http === 200 && present === expectPresent, seconds_to_expected:final.http === 200 && present === expectPresent ? Math.round((new Date(final.at) - new Date(started)) / 1000) : null};
  const s = record.stages;
  record.result = s.before && s.uploaded && s.deleted ? (s.before.as_expected && s.uploaded.as_expected && s.deleted.as_expected ? 'PASS' : 'FAIL') : 'INCOMPLETE';
  record.extracted_at = now();
  return save(`lifecycle-${slug}`, record);
}

// ── S1: cross-tenant retrieval ───────────────────────────────────────────
// Tenant A holds canary-alpha.txt, tenant B canary-beta.txt. Each is asked for
// its own code (the control: retrieval works, so a pass is not a false
// negative) and for the other's (must never come back, in the answer or in
// `sources`).
async function isolation(){
  const A = await tenant(required('--a')), B = await tenant(required('--b'));
  if(A.id === B.id) fail('--a and --b must be different tenants');
  const sides = [{t:A, own:CANARIES.alpha, other:CANARIES.beta}, {t:B, own:CANARIES.beta, other:CANARIES.alpha}];
  for(const s of sides){
    s.docs = await documents(s.t.id);
    if(!s.docs.some(d => d.status === 'uploaded' && fromFile(d.object_key, s.own.file))) fail(`Setup: upload ${s.own.file} to ${s.t.slug}`);
    if(s.docs.some(d => fromFile(d.object_key, s.other.file))) fail(`Setup: ${s.t.slug} must not hold ${s.other.file}`);
  }
  const keysOf = s => new Set(s.docs.map(d => d.object_key));
  const probes = [];
  for(const [i, s] of sides.entries()){
    const peer = sides[1 - i]; const base = s.t.chatbot_url.replace(/\/$/,'');
    for(const [kind, canary] of [['control', s.own], ['probe', s.other]]){
      const a = await ask(base, canary.question);
      const leakedCode = mentions(a.answer, peer.own.code);
      const peerKeys = a.sources.filter(k => keysOf(peer).has(k) || fromFile(k, peer.own.file));
      const foreignKeys = a.sources.filter(k => !keysOf(s).has(k));
      const p = {tenant:s.t.slug, cloud:s.t.cloud_provider, vector_store:s.t.vector_store, kind, question:canary.question, ...a,
        own_code_in_answer:mentions(a.answer, s.own.code), peer_code_in_answer:leakedCode, peer_sources:peerKeys, sources_not_owned:foreignKeys};
      p.result = a.http !== 200 ? 'ERROR' : kind === 'control' ? (p.own_code_in_answer ? 'PASS' : 'FAIL') : (!leakedCode && !peerKeys.length && !foreignKeys.length ? 'PASS' : 'FAIL');
      console.log(`${p.result.padEnd(6)} ${s.t.slug} ${kind}: ${canary.question}`);
      probes.push(p);
    }
  }
  const leak = probes.some(p => p.kind === 'probe' && p.result === 'FAIL');
  const controlsOk = probes.filter(p => p.kind === 'control').every(p => p.result === 'PASS');
  const result = probes.some(p => p.result === 'ERROR') ? 'INCONCLUSIVE' : leak ? 'FAIL' : controlsOk ? 'PASS' : 'INCONCLUSIVE';
  return save('isolation', {command:'isolation', extracted_at:now(), tenants:sides.map(s => ({slug:s.t.slug, id:s.t.id, cloud:s.t.cloud_provider, vector_store:s.t.vector_store, canary:s.own.file})),
    same_cloud:A.cloud_provider === B.cloud_provider, result,
    summary:result === 'INCONCLUSIVE' && !leak ? 'No leak, but a control failed or a request errored, so retrieval was not shown to work and the probe proves nothing.' : undefined,
    probes});
}

// ── E3: idempotency ──────────────────────────────────────────────────────
async function idempotency(){
  const slug = required('--tenant'); const t = await tenant(slug);
  const all = (await deploys(t.id)).filter(d => d.kind === 'deploy');
  const chosen = option('--run') ? all.find(d => d.github_run_id === option('--run')) : all.filter(d => d.status === 'succeeded').at(-1);
  if(!chosen?.github_run_id) fail('No succeeded deploy with a GitHub run for this tenant');
  const earlier = all.filter(d => d.status === 'succeeded' && new Date(d.started_at) < new Date(chosen.started_at));
  const jobs = (await github(`actions/runs/${chosen.github_run_id}/jobs?per_page=100`)).jobs;
  const applies = [], changes = [];
  for(const job of jobs){
    for(const {text:line} of await jobLog(job.id)){
      const m = /Apply complete! Resources: (\d+) added, (\d+) changed, (\d+) destroyed/.exec(line);
      if(m) applies.push({job:job.name, added:+m[1], changed:+m[2], destroyed:+m[3]});
      const c = /^\s*# (\S+) (will be|must be) (.+)$/.exec(line);
      if(c) changes.push({job:job.name, resource:c[1], action:`${c[2]} ${c[3]}`});
    }
  }
  const zero = applies.length > 0 && applies.every(a => !a.added && !a.changed && !a.destroyed);
  const result = chosen.status !== 'succeeded' ? 'FAIL' : !earlier.length ? 'NOT A REDEPLOY' : !applies.length ? 'INCONCLUSIVE' : zero ? 'PASS' : 'FAIL';
  return save(`idempotency-${slug}`, {command:'idempotency', tenant:slug, cloud:t.cloud_provider, vector_store:t.vector_store, extracted_at:now(),
    deployment:{id:chosen.id, status:chosen.status, run:chosen.github_run_url, started_at:chosen.started_at, finished_at:chosen.finished_at, minutes:minutes(chosen.started_at, chosen.finished_at)},
    timing:{github:await runTiming(chosen)}, earlier_successful_deploys:earlier.length, applies, changes, result,
    note:'Pass criterion: a redeploy of an unchanged tenant reports "0 added, 0 changed, 0 destroyed" for every terraform apply in the run (two on Azure).'});
}

// ── Cloud CLIs (read-only calls only) ────────────────────────────────────
function cli(bin, argv){
  // az is a .cmd script on Windows and needs a shell; aws is an executable.
  const r = spawnSync(bin, [...argv, '--output', 'json'], {encoding:'utf8', shell:bin === 'az' && process.platform === 'win32', maxBuffer:256 * 1024 * 1024});
  if(r.status !== 0) throw new Error(`${bin} ${argv.slice(0,3).join(' ')}: ${(r.stderr || r.error?.message || '').trim().split('\n').at(-1)}`);
  return r.stdout.trim() ? JSON.parse(r.stdout) : null;
}
const awsArgs = t => [...(option('--profile') ? ['--profile', option('--profile')] : []), '--region', option('--region') ?? t.aws_region];
const aws = (t, ...argv) => cli('aws', [...argv, ...awsArgs(t)]);

// ── S4: platform activity in the customer account ────────────────────────
// CloudTrail event history (free, management events, 90 days) over the window
// from onboarding to the last deploy. "Platform activity" is any event by the
// platform account or by the onboarding role it assumes; the documented
// inventory (SECURITY.md, tenant-bootstrap.yaml) allows exactly: assume the
// onboarding role, and create or update this chatbot's secrets. Data events
// (S3 object reads) are not in event history; S2 covers them statically.
async function cloudtrail(){
  const slug = required('--tenant'); const t = await tenant(slug, {deleted:true});
  if(t.cloud_provider !== 'aws') fail('S4 is AWS only');
  const platform = process.env.PLATFORM_AWS_ACCOUNT_ID; if(!platform) fail('PLATFORM_AWS_ACCOUNT_ID is not set');
  const d = (await deploys(t.id)).filter(x => x.finished_at);
  const from = new Date(new Date(t.created_at) - 10 * 60000), to = new Date(Math.max(...d.map(x => +new Date(x.finished_at)), +new Date(t.created_at)) + 10 * 60000);
  if(Date.now() - to < 5 * 60000) console.warn('CloudTrail delivers events up to 15 minutes late; rerun later if the window just closed.');
  const regions = [...new Set([option('--region') ?? t.aws_region, 'us-east-1'])];
  const seen = new Map();
  for(const region of regions){
    const out = cli('aws', ['cloudtrail', 'lookup-events', '--start-time', from.toISOString(), '--end-time', to.toISOString(), ...(option('--profile') ? ['--profile', option('--profile')] : []), '--region', region]);
    for(const e of out?.Events ?? []) if(!seen.has(e.EventId)) seen.set(e.EventId, {region, ...JSON.parse(e.CloudTrailEvent)});
  }
  const onboard = `chatbot-client-onboard-${slug}`, deploy = `chatbot-client-deploy-${slug}`;
  const actor = e => e.userIdentity?.sessionContext?.sessionIssuer?.arn ?? e.userIdentity?.arn ?? `${e.userIdentity?.type}:${e.userIdentity?.accountId ?? '?'}`;
  const isPlatform = e => e.userIdentity?.accountId === platform && e.recipientAccountId !== platform || actor(e).endsWith(`role/${onboard}`);
  const allowed = e => {
    const p = e.requestParameters ?? {};
    if(e.eventSource === 'sts.amazonaws.com' && e.eventName === 'AssumeRole') return String(p.roleArn ?? '').endsWith(`:role/${onboard}`);
    if(e.eventSource === 'secretsmanager.amazonaws.com' && ['CreateSecret','UpdateSecret'].includes(e.eventName)) { const id = String(p.name ?? p.secretId ?? ''); return id.startsWith(`${slug}/`) || id.includes(`:secret:${slug}/`); }
    return false;
  };
  const events = [...seen.values()];
  const platformEvents = events.filter(isPlatform).map(e => ({time:e.eventTime, region:e.region, source:e.eventSource, name:e.eventName, actor:actor(e), error:e.errorCode ?? null, target:e.requestParameters?.roleArn ?? e.requestParameters?.name ?? e.requestParameters?.secretId ?? null, allowed:allowed(e)}));
  const tally = list => Object.entries(list.reduce((m, e) => (m[`${e.eventSource}:${e.eventName}`] = (m[`${e.eventSource}:${e.eventName}`] ?? 0) + 1, m), {})).sort((a, b) => b[1] - a[1]);
  const violations = platformEvents.filter(e => !e.allowed);
  const result = !events.length ? 'INCONCLUSIVE' : violations.length ? 'FAIL' : platformEvents.some(e => e.name === 'AssumeRole') ? 'PASS' : 'INCONCLUSIVE';
  return save(`cloudtrail-${slug}`, {command:'cloudtrail', tenant:slug, extracted_at:now(), window:{from:from.toISOString(), to:to.toISOString()}, regions, events_in_window:events.length,
    result, summary:result === 'INCONCLUSIVE' ? 'No platform AssumeRole in the window: onboarding may predate event history or fall outside the window, so absence of violations proves nothing.' : undefined,
    allowed_inventory:[`sts:AssumeRole on role/${onboard}`, `secretsmanager:CreateSecret|UpdateSecret on secret ${slug}/*`],
    platform_events:platformEvents, violations,
    deployment_role_activity:tally(events.filter(e => actor(e).endsWith(`role/${deploy}`))).map(([k, n]) => ({action:k, count:n}))});
}

// ── E4: what a teardown leaves behind ────────────────────────────────────
// Run after the teardown workflow succeeds. The bootstrap (deploy and
// onboarding roles, state bucket or state account, the deploy identity) is
// the customer's and survives by design; anything else that still carries the
// tenant's name or tag is a leftover.
async function inventory(){
  const slug = required('--tenant'); const t = await tenant(slug, {deleted:true});
  const found = [], errors = [];
  const add = (type, id, extra = {}) => found.push({type, id, ...extra});
  const tryList = (label, fn) => { try { fn(); } catch(e) { errors.push(`${label}: ${e.message}`); } };
  const has = s => String(s).toLowerCase().includes(slug.toLowerCase());
  if(t.cloud_provider === 'aws'){
    tryList('tagging', () => (aws(t, 'resourcegroupstaggingapi', 'get-resources', '--tag-filters', `Key=Tenant,Values=${slug}`).ResourceTagMappingList ?? []).forEach(r => add('tagged', r.ResourceARN)));
    tryList('s3', () => (aws(t, 's3api', 'list-buckets').Buckets ?? []).filter(b => has(b.Name)).forEach(b => add('s3-bucket', b.Name)));
    tryList('ecr', () => (aws(t, 'ecr', 'describe-repositories').repositories ?? []).filter(r => has(r.repositoryName)).forEach(r => add('ecr-repository', r.repositoryName)));
    tryList('logs', () => (aws(t, 'logs', 'describe-log-groups', '--log-group-name-pattern', slug).logGroups ?? []).forEach(g => add('log-group', g.logGroupName)));
    tryList('secrets', () => (aws(t, 'secretsmanager', 'list-secrets', '--include-planned-deletion').SecretList ?? []).filter(s => has(s.Name)).forEach(s => add('secret', s.Name, {scheduled_deletion:s.DeletedDate ?? null})));
    tryList('rds', () => (aws(t, 'rds', 'describe-db-instances').DBInstances ?? []).filter(i => has(i.DBInstanceIdentifier)).forEach(i => add('rds-instance', i.DBInstanceIdentifier, {status:i.DBInstanceStatus})));
    tryList('rds-snapshots', () => (aws(t, 'rds', 'describe-db-snapshots').DBSnapshots ?? []).filter(s => has(s.DBSnapshotIdentifier) || has(s.DBInstanceIdentifier)).forEach(s => add('rds-snapshot', s.DBSnapshotIdentifier)));
    tryList('lambda', () => (aws(t, 'lambda', 'list-functions').Functions ?? []).filter(f => has(f.FunctionName)).forEach(f => add('lambda', f.FunctionName)));
    tryList('ecs', () => (aws(t, 'ecs', 'list-clusters').clusterArns ?? []).filter(has).forEach(a => add('ecs-cluster', a)));
    tryList('elb', () => (aws(t, 'elbv2', 'describe-load-balancers').LoadBalancers ?? []).filter(l => has(l.LoadBalancerName)).forEach(l => add('load-balancer', l.LoadBalancerName)));
    tryList('vpc', () => (aws(t, 'ec2', 'describe-vpcs', '--filters', `Name=tag:Tenant,Values=${slug}`).Vpcs ?? []).forEach(v => add('vpc', v.VpcId)));
    tryList('iam', () => (aws(t, 'iam', 'list-roles').Roles ?? []).filter(r => has(r.RoleName)).forEach(r => add('iam-role', r.RoleName)));
  }else{
    const sub = option('--subscription') ?? t.azure_subscription_id; const group = t.azure_resource_group ?? `chatbot-${slug}`;
    const az = (...argv) => cli('az', [...argv, '--subscription', sub]);
    tryList('group', () => { if(az('group', 'exists', '--name', group)) add('resource-group', group); });
    tryList('resources', () => (az('resource', 'list', '--resource-group', group) ?? []).forEach(r => add(r.type, r.name)));
    tryList('deleted-vaults', () => (az('keyvault', 'list-deleted') ?? []).filter(v => has(v.name)).forEach(v => add('key-vault-soft-deleted', v.name, {purge_date:v.properties?.scheduledPurgeDate ?? null})));
  }
  const compact = slug.replace(/-/g,'');
  const bootstrap = r =>
    (r.type === 'iam-role' && [`chatbot-client-deploy-${slug}`, `chatbot-client-onboard-${slug}`].includes(r.id)) ||
    (r.type === 's3-bucket' && r.id.startsWith(`tfstate-${slug}-`)) ||
    (r.type === 'tagged' && /:s3:::tfstate-/.test(r.id)) ||
    (r.type === 'resource-group') ||
    (/managedidentity\/userassignedidentities/i.test(r.type) && r.id === `chatbot-deploy-${slug}`) ||
    (/storage\/storageaccounts/i.test(r.type) && r.id === `cbtf${compact}`);
  const pending = r => r.scheduled_deletion || r.type === 'key-vault-soft-deleted';
  for(const r of found) r.class = bootstrap(r) ? 'bootstrap (customer-owned, by design)' : pending(r) ? 'pending deletion (by design)' : 'leftover';
  const leftovers = found.filter(r => r.class === 'leftover');
  const result = errors.length ? 'INCONCLUSIVE' : leftovers.length ? 'FAIL' : 'PASS';
  return save(`inventory-${slug}`, {command:'inventory', tenant:slug, cloud:t.cloud_provider, deleted_at:t.deleted_at, extracted_at:now(), result, leftovers:leftovers.length, resources:found, errors,
    note:'Name and tag matching finds what Terraform names after the tenant; an untagged resource with an unrelated name would be missed. The tagging API can list a resource for a few minutes after deletion.'});
}

// ── Report ───────────────────────────────────────────────────────────────
function report(){
  const results = fs.readdirSync(dir).filter(f => f.endsWith('.json') && f !== 'golden.json').map(f => ({file:f, ...JSON.parse(fs.readFileSync(path.join(dir, f),'utf8'))}));
  const by = cmd => results.filter(r => r.command === cmd);
  const cell = s => String(s ?? '—').replace(/\|/g,'\\|').replace(/\n/g,' ');
  const pct = m => m && m.n ? `${m.hits}/${m.n} (${Math.round(100 * m.hits / m.n)}%)` : '—';
  const lines = ['# Live tenant evaluation', '', `Generated ${now()} by \`node scripts/evaluate-live.cjs report\` from the result files in this directory. Each row of the evidence matrix (\`EVALUATION.md\` §1.1) that needs a deployed chatbot has one subcommand; see the script header. Scoring rules were fixed in the script before the runs, and every answer is archived verbatim in the JSON files.`, ''];
  const row = (id, claim, r, metric) => `| ${id} | ${claim} | ${r ? `**${r.result}**` : 'not run'} | ${cell(metric)} | ${r ? `\`${r.file}\`` : '—'} |`;
  lines.push('| Row | Claim | Result | Metric | Evidence |', '|---|---|---|---|---|');
  for(const r of by('readiness')) lines.push(row('E1', `Deployment is automated (${r.tenant}, ${r.cloud} ${r.vector_store})`, r, r.minutes ? Object.entries(r.minutes).map(([k, v]) => `${k}: ${v ?? '—'} min`).join('; ') : r.reason));
  if(!by('readiness').length) lines.push(row('E1', 'Deployment is automated'));
  for(const r of by('idempotency')) lines.push(row('E3', `Terraform is idempotent (${r.tenant})`, r, r.applies.map(a => `${a.added}/${a.changed}/${a.destroyed}`).join(', ') || 'no apply found'));
  if(!by('idempotency').length) lines.push(row('E3', 'Terraform is idempotent'));
  for(const r of by('inventory')) lines.push(row('E4', `Cleanup works (${r.tenant})`, r, `${r.leftovers} leftover(s); ${r.resources.length - r.leftovers} kept by design`));
  if(!by('inventory').length) lines.push(row('E4', 'Cleanup works'));
  for(const r of by('qa')){
    lines.push(row('E7', `RAG retrieves client knowledge (${r.tenant})`, {...r, result:'see metric'}, `expected source cited: ${pct(r.metrics.E7_expected_source)}`));
    lines.push(row('E8', `Answers are grounded (${r.tenant})`, {...r, result:'see metric'}, `expected facts present: ${pct(r.metrics.E8_expected_facts)}; faithfulness: manual rubric`));
    lines.push(row('E9', `Unknown information is rejected (${r.tenant})`, {...r, result:'see metric'}, `abstained: ${pct(r.metrics.E9_abstention)}; ${r.metrics.adversarial_for_review} adversarial for review`));
  }
  if(!by('qa').length) ['E7','E8','E9'].forEach(id => lines.push(row(id, {E7:'RAG retrieves client knowledge', E8:'Answers are grounded', E9:'Unknown information is rejected'}[id])));
  for(const r of by('lifecycle')) lines.push(row('E10', `Knowledge follows the document lifecycle (${r.tenant})`, r, ['before','uploaded','deleted'].map(s => `${s}: ${r.stages[s] ? (r.stages[s].present ? 'present' : 'absent') : '—'}`).join(' → ')));
  if(!by('lifecycle').length) lines.push(row('E10', 'Knowledge follows the document lifecycle'));
  const iso = by('isolation')[0];
  lines.push(row('S1', 'One tenant\'s chatbot cannot retrieve another tenant\'s documents', iso, iso ? `${iso.tenants.map(t => `${t.slug} (${t.cloud} ${t.vector_store})`).join(' vs ')}${iso.same_cloud ? '' : '; different clouds'}` : undefined));
  for(const r of by('cloudtrail')) lines.push(row('S4', `Platform activity stays within the inventory (${r.tenant})`, r, `${r.platform_events.length} platform event(s), ${r.violations.length} outside the inventory`));
  if(!by('cloudtrail').length) lines.push(row('S4', 'Platform activity stays within the inventory'));
  lines.push('');

  for(const r of [...by('readiness'), ...by('idempotency')].filter(r => r.timing?.github?.jobs)){
    const g = r.timing.github;
    lines.push(`## Deployment timing: ${r.tenant} (${r.command === 'readiness' ? 'first deploy' : r.result === 'NOT A REDEPLOY' ? 'deploy' : 'redeploy'})`, '',
      `Database: T0 ${r.timing.database?.T0 ?? r.deployment.started_at}, T5 ${r.timing.database?.T5 ?? r.deployment.finished_at}. GitHub run created ${g.run_created_at}, at commit \`${String(g.head_sha).slice(0,12)}\`.`, '',
      ...(r.minutes ? Object.entries(r.minutes).map(([k, v]) => `- ${k}: ${v ?? '—'} min`) : []),
      ...Object.entries(g.minutes).map(([k, v]) => `- ${k}: ${v ?? '—'} min`), '');
    const total = Object.values(g.stages_seconds ?? {}).reduce((a, b) => a + (b ?? 0), 0);
    if(g.stages_seconds) lines.push('| Stage | Seconds | Share of run |', '|---|---:|---:|',
      ...Object.entries(g.stages_seconds).map(([k, v]) => `| ${k} | ${v ?? '—'} | ${v && total ? Math.round(100 * v / total) + '%' : '—'} |`), `| **total** | **${total}** | |`, '');
    if(g.applies?.length) lines.push(...g.applies.map(a => `- ${a.step}: ${a.seconds} s, of which planning ${a.planning ?? '—'} s and provisioning ${a.provisioning ?? '—'} s`), '');
    lines.push('<details><summary>Every step</summary>', '', '| Job | Step | Stage | Seconds | Conclusion |', '|---|---|---|---:|---|',
      ...g.jobs.flatMap(j => j.steps.filter(s => s.seconds).map(s => `| ${cell(j.name)} | ${cell(s.name)} | ${s.stage ?? '—'} | ${s.seconds} | ${s.conclusion} |`)), '', '</details>', '');
  }
  const attempts = by('readiness');
  if(attempts.length) lines.push('## Deployment success rate (this session)', '', `${attempts.filter(r => r.timing?.github?.conclusion === 'success' || r.deployment?.status === 'succeeded' || r.marks?.T5).length} of ${attempts.length} deploy attempts succeeded; ${attempts.filter(r => r.result === 'PASS').length} reached a healthy, correctly answering chatbot. Historical attempts are in \`../oidc/REPORT.md\`.`, '');
  for(const r of by('qa')){
    lines.push(`## Golden set: ${r.tenant}`, '', `${r.golden_source}. Median latency of answered questions: ${r.metrics.latency_ms_median ?? '—'} ms.`, '',
      '| Case | Category | Result | Source cited | Facts | Abstained | Answer |', '|---|---|---|---|---|---|---|',
      ...r.cases.map(c => `| ${c.id} | ${c.category} | ${c.result} | ${c.source_hit ?? '—'} | ${c.facts_present ?? '—'} | ${c.abstained} | ${cell((c.answer ?? c.error ?? '').slice(0, 160))} |`), '', `Manual rubric: ${r.manual_rubric}`, '');
  }
  if(iso){
    lines.push('## S1: cross-tenant retrieval', '', ...(iso.summary ? [iso.summary, ''] : []), iso.same_cloud ? '' : 'The two tenants run in different clouds, so a pass shows the platform never routes one tenant\'s question to the other\'s store; it does not exercise two tenants sharing a cloud account.', '',
      '| Tenant | Kind | Question | Result | Own code in answer | Peer code in answer | Peer sources |', '|---|---|---|---|---|---|---|',
      ...iso.probes.map(p => `| ${p.tenant} | ${p.kind} | ${cell(p.question)} | **${p.result}** | ${p.own_code_in_answer} | ${p.peer_code_in_answer} | ${p.peer_sources.length} |`), '');
  }
  for(const r of by('cloudtrail')){
    lines.push(`## S4: CloudTrail, ${r.tenant}`, '', `${r.events_in_window} events between ${r.window.from} and ${r.window.to} (${r.regions.join(', ')}). Allowed: ${r.allowed_inventory.join('; ')}.`, '', ...(r.summary ? [r.summary, ''] : []),
      '| Time | Action | Actor | Target | Allowed |', '|---|---|---|---|---|', ...r.platform_events.map(e => `| ${e.time} | ${e.source.split('.')[0]}:${e.name} | ${cell(e.actor.replace(/\d{12}/g,'<account>'))} | ${cell(e.target)} | ${e.allowed ? 'yes' : '**no**'} |`), '');
  }
  for(const r of by('inventory')) lines.push(`## E4: after teardown, ${r.tenant}`, '', '| Type | Resource | Class |', '|---|---|---|', ...r.resources.map(x => `| ${x.type} | ${cell(x.id.replace(/\d{12}/g,'<account>'))} | ${x.class} |`), '', ...r.errors.map(e => `- error: ${e}`), r.note, '');
  fs.writeFileSync(path.join(dir,'REPORT.md'), lines.join('\n') + '\n');
  console.log(`Wrote ${dir}/REPORT.md`);
}

const commands = {readiness, qa, lifecycle, isolation, idempotency, cloudtrail, inventory, report};
if(!commands[command]) fail(`Usage: node scripts/evaluate-live.cjs <${Object.keys(commands).join('|')}> [options]; see the header of this file.`);
Promise.resolve(commands[command]()).catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
