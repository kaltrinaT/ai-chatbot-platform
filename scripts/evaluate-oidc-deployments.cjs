/* eslint-disable @typescript-eslint/no-require-imports -- Standalone CommonJS evaluation script. */
const fs = require('node:fs');
const dotenv = require('dotenv');
dotenv.config({path:'.env.local',quiet:true}); dotenv.config({quiet:true});
const {neon} = require('@neondatabase/serverless');
const {execFileSync} = require('node:child_process');
// Only deployments of the evaluated implementation count. Pass the commit that
// implementation starts from: node scripts/evaluate-oidc-deployments.cjs --from <sha>
// A run is kept when it started after that commit and its workflow ran at a
// commit that contains it; earlier development runs stay in the database and
// are only counted as excluded.
const fromArg = process.argv.indexOf('--from');
if(fromArg < 0 || !process.argv[fromArg + 1]) { console.error('Usage: node scripts/evaluate-oidc-deployments.cjs --from <commit>'); process.exit(1); }
const git = (...args) => execFileSync('git', args, {encoding:'utf8'}).trim();
const fromCommit = git('rev-parse', process.argv[fromArg + 1]);
const cutoff = new Date(Number(git('show', '-s', '--format=%ct', fromCommit)) * 1000).toISOString();
const containsFix = sha => { try { execFileSync('git', ['merge-base', '--is-ancestor', fromCommit, sha], {stdio:'ignore'}); return true; } catch { return false; } };
const dir = 'docs/evaluation/oidc'; fs.mkdirSync(dir,{recursive:true});
async function api(path) {
  const response = await fetch(`https://api.github.com/repos/${process.env.CHATBOT_REPO_OWNER}/${process.env.CHATBOT_REPO_NAME}/${path}`,{headers:{Authorization:`Bearer ${process.env.GITHUB_PAT}`,Accept:'application/vnd.github+json'}});
  if(!response.ok) throw new Error(`GitHub HTTP ${response.status}`);
  return response.json();
}
async function main(){
 const rows = await neon(process.env.DATABASE_URL).query(`SELECT d.id,d.tenant_id,d.kind,d.status,d.chatbot_version,d.github_run_id,d.github_run_url,d.started_at,d.finished_at,d.error_message,t.cloud_provider,t.vector_store,t.created_at AS tenant_created_at FROM deployments d JOIN tenants t ON t.id=d.tenant_id ORDER BY d.started_at`);
 const afterCutoff = rows.filter(r=>r.kind==='deploy' && new Date(r.started_at)>=new Date(cutoff));
 for(const row of afterCutoff){
  row.duration_minutes = row.finished_at ? (new Date(row.finished_at)-new Date(row.started_at))/60000 : null;
  try{
   const run = await api(`actions/runs/${row.github_run_id}`);
   row.github = {head_sha:run.head_sha,path:run.path,conclusion:run.conclusion,run_attempt:run.run_attempt,created_at:run.created_at,run_started_at:run.run_started_at,updated_at:run.updated_at,html_url:run.html_url};
   const path = run.path.split('@')[0];
   const content = await api(`contents/${path}?ref=${run.head_sha}`);
   const workflow = Buffer.from(content.content,'base64').toString('utf8');
   row.oidc_verified = workflow.includes('id-token: write') && (row.cloud_provider==='aws' ? workflow.includes('unset-current-credentials: true') && workflow.includes('inputs.deployment_role_arn') : workflow.includes('uses: azure/login@v2') && workflow.includes('client-id:') && !workflow.includes('creds:'));
   row.jobs = (await api(`actions/runs/${row.github_run_id}/attempts/${run.run_attempt}/jobs?per_page=100`)).jobs.map(j=>({name:j.name,conclusion:j.conclusion,started_at:j.started_at,completed_at:j.completed_at,steps:j.steps}));
   fs.writeFileSync(`${dir}/workflow-${run.head_sha}-${row.cloud_provider}.yml`,workflow);
  }catch(error){ row.github_error = error.message; row.oidc_verified = row.oidc_verified ?? false; }
 }
 // A run with no recorded workflow commit cannot be shown to be the evaluated version.
 const candidates = afterCutoff.filter(r=>r.github?.head_sha && containsFix(r.github.head_sha));
 const deploys = rows.filter(r=>r.kind==='deploy');
 fs.writeFileSync(`${dir}/history.json`,JSON.stringify({extracted_at:new Date().toISOString(),from_commit:fromCommit,cutoff,total_rows:rows.length,total_deploys:deploys.length,total_teardowns:rows.filter(r=>r.kind==='destroy').length,excluded_earlier_versions:deploys.length-candidates.length,candidates},null,2));
 console.log(JSON.stringify({total_rows:rows.length,total_deploys:rows.filter(r=>r.kind==='deploy').length,candidates:candidates.map(r=>({id:r.id,cloud:r.cloud_provider,store:r.vector_store,status:r.status,minutes:r.duration_minutes,oidc:r.oidc_verified,error:r.github_error,sha:r.github?.head_sha}))},null,2));
}
main().catch(error=>{console.error(error.message);process.exitCode=1});
