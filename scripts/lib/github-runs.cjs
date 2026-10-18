/* eslint-disable @typescript-eslint/no-require-imports -- Shared by CommonJS evaluation scripts. */
// Reading deployment runs back from GitHub Actions, shared by the live
// evaluation (evaluate-live.cjs) and the timing evaluation
// (evaluate-deployment-timings.cjs), so both split a run into the same stages.
const {keyPatterns} = require('./security-model.cjs');

const repoPath = () => `${process.env.CHATBOT_REPO_OWNER}/${process.env.CHATBOT_REPO_NAME}`;

async function github(p, raw = false){
  const r = await fetch(`https://api.github.com/repos/${repoPath()}/${p}`, {headers:{...(process.env.GITHUB_PAT ? {Authorization:`Bearer ${process.env.GITHUB_PAT}`} : {}), Accept:'application/vnd.github+json'}});
  if(!r.ok){ const e = new Error(`GitHub ${p}: HTTP ${r.status}`); e.status = r.status; throw e; }
  return raw ? r.text() : r.json();
}

/** A job's log as timestamped lines, colour codes stripped. */
async function jobLog(jobId){
  return (await github(`actions/jobs/${jobId}/logs`, true)).split(/\r?\n/).map(line => {
    const m = /^(\d{4}-\d\d-\d\dT[\d:.]+Z) (.*)$/.exec(line);
    return {ts:m?.[1] ?? null, text:(m?.[2] ?? line).replace(/\x1b\[[0-9;]*m/g, '')};
  });
}

// Steps are grouped into stages that mean the same thing on both clouds, so
// AWS and Azure can be compared stage by stage. The workflows run
// `terraform apply -auto-approve`, which plans and applies in one step; the
// timestamp GitHub puts on Terraform's "Plan: …" line splits that step into
// planning and provisioning without changing the workflow under test.
const STAGES = [
  ['images', /pull source images|replicate images|retag and push|log in to acr/i],
  ['cloud sign-in', /configure aws credentials|azure login/i],
  ['terraform init', /terraform init/i],
  ['terraform apply', /terraform apply|terraform destroy/i],
  ['propagation wait', /propagate/i],
  ['post-apply', /read terraform outputs|docs-signer|upload deployment outputs|notify platform — success|upload-artifact/i],
];
const stageOf = name => STAGES.find(([, re]) => re.test(name))?.[0] ?? 'workflow setup';
const seconds = (a, b) => a && b ? Math.round((new Date(b) - new Date(a)) / 1000) : null;
const minutes = (a, b) => a && b ? Math.round((new Date(b) - new Date(a)) / 600) / 100 : null;

/**
 * What a run's log says, without keeping the log: Terraform's plan and apply
 * counts, when planning ended inside each apply step, the vector store the
 * run was given, and the error lines. Logs can hold anything a step printed,
 * so nothing else is retained, and what is kept passes through redact().
 */
function readLog(lines, steps){
  const plans = [], applies = [], errors = [], resources = [];
  let vectorStore = null;
  for(const l of lines){
    let m;
    // Terraform's per-resource plan lines, e.g. "# aws_ecs_service.backend will be updated in-place".
    if((m = /^\s*# ([\w.[\]"-]+) (?:will be|must be) (created|destroyed|updated in-place|replaced|read during apply)/.exec(l.text))) resources.push(`${m[1].replace(/\["?[^\]]*"?\]/g, '[]')} ${m[2]}`);
    if((m = /Plan: (\d+) to add, (\d+) to change, (\d+) to destroy/.exec(l.text))) plans.push({ts:l.ts, add:+m[1], change:+m[2], destroy:+m[3]});
    else if(/No changes\. (Your infrastructure matches|Infrastructure is up-to-date)/.test(l.text)) plans.push({ts:l.ts, add:0, change:0, destroy:0});
    if((m = /Apply complete! Resources: (\d+) added, (\d+) changed, (\d+) destroyed/.exec(l.text))) applies.push({ts:l.ts, added:+m[1], changed:+m[2], destroyed:+m[3]});
    if((m = /Destroy complete! Resources: (\d+) destroyed/.exec(l.text))) applies.push({ts:l.ts, added:0, changed:0, destroyed:+m[1]});
    if(!vectorStore && (m = /vector_store"?\s*[:=]\s*"?(pinecone|pgvector)\b/i.exec(l.text))) vectorStore = m[1].toLowerCase();
    if(/^##\[error\]|^Error: |│ Error: /.test(l.text)) errors.push(redact(l.text.replace(/^##\[error\]/, '').trim()).slice(0, 300));
  }
  // Planning time inside each apply step: from the step's start to its "Plan:" line.
  const planning = (steps ?? []).filter(s => stageOf(s.name) === 'terraform apply' && s.started_at && s.completed_at).map(s => {
    const inStep = t => t && Date.parse(t) >= Date.parse(s.started_at) - 1000 && Date.parse(t) <= Date.parse(s.completed_at) + 1000;
    const plan = plans.find(p => inStep(p.ts));
    return {step:s.name, seconds:seconds(s.started_at, s.completed_at), planning:plan ? seconds(s.started_at, plan.ts) : null};
  });
  return {plans:plans.map(p => ({add:p.add, change:p.change, destroy:p.destroy})), applies:applies.map(a => ({added:a.added, changed:a.changed, destroyed:a.destroyed})), planning, vector_store:vectorStore, errors:[...new Set(errors)].slice(0, 12), resources:resources.sort()};
}

/** Credentials and account numbers out of anything that is archived. */
function redact(text){
  let out = String(text);
  for(const re of Object.values(keyPatterns)) out = out.replace(new RegExp(re.source, 'g'), '[REDACTED]');
  return out.replace(/\b\d{12}\b/g, '<account>').replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>');
}

module.exports = {github, jobLog, STAGES, stageOf, seconds, minutes, readLog, redact, repoPath};
