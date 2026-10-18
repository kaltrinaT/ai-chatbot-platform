/* eslint-disable @typescript-eslint/no-require-imports -- Standalone CommonJS evaluation script. */
// Security mutation testing: does each security test fail when the control it
// is about is taken away?
//
//   npm run evaluate:security:mutants                  every hand-written mutant
//   npm run evaluate:security:mutants -- M07 R02       only these (printed, not archived)
//   npm run evaluate:security:mutants -- --class harness
//   npm run evaluate:security:mutants -- --generated   the generated mutants (scripts/lib/generated-mutants.cjs)
//   npm run evaluate:security:mutants -- --check       confirm every anchor still resolves; runs nothing
//
// A passing security test proves little unless it would fail if the control
// it is about were gone. Each mutant removes or weakens exactly one control in
// the real source, template or workflow. The runner applies it, runs the tests
// meant to catch it, records whether any test failed (the mutant is "killed"),
// and restores the file byte for byte.
//
// The hand-written mutants come in four classes:
//
//   control      one per claim of the local scenarios (SEC-E2E-01 … 04)
//   regression   each vulnerability this evaluation found, put back as it was
//                found; the fix is only locked in if its tests notice it going
//   attack       the unit-level attack matrix (EVALUATION.md §5): OIDC, the
//                webhook, the proxy perimeter, sign-in, erasure
//   harness      the test harness's own oracles — the IAM evaluator, the Entra
//                matcher, the workflow runner — broken so that, if the tests
//                passed anyway, they would be passing without proving anything
//
// Hand-written mutants are chosen, which invites the question whether they
// were chosen because they would be caught. --generated answers it: every
// guard, query condition and validator in the security-critical files becomes
// a mutant mechanically, and the score is whatever it is. Survivors are
// reviewed in generated-triage.json; an unreviewed one is reported as such.
//
// Some hand-written mutants are expected to survive because a second,
// independent control still blocks the attack; each of those is paired with
// one that removes both layers and must be killed, so a survivor is evidence
// of defence in depth rather than of a blind spot. Expectations are fixed in
// this file before the run, and a mutant that does not behave as expected
// fails the run.
//
// Writes docs/evaluation/security-mutation/: REPORT.md, results.json (the
// hand-written run) and generated.json (the generated run). A run limited to
// some mutants prints its results but leaves the archive alone, so each file
// always describes one complete run.
const fs = require('node:fs'); const path = require('node:path'); const os = require('node:os');
const {spawnSync, execSync} = require('node:child_process');
const {generatedMutants, SOURCES} = require('./lib/generated-mutants.cjs');

const dir = 'docs/evaluation/security-mutation'; fs.mkdirSync(dir, {recursive:true});
const UNIT = 'vitest.config.mts', E2E = 'vitest.security.config.mts';
const S = {
  '01':'src/security-e2e/sec-e2e-01-tenant-authorization.e2e.test.ts',
  '02':'src/security-e2e/sec-e2e-02-document-access.e2e.test.ts',
  '03':'src/security-e2e/sec-e2e-03-identity-isolation.e2e.test.ts',
  '04':'src/security-e2e/sec-e2e-04-workflow-integrity.e2e.test.ts',
};
const ACTIONS = 'src/app/tenants/[id]/actions.ts', DOCS = 'src/app/tenants/[id]/documents/actions.ts';
const STATUS = 'src/app/api/deployments/[id]/status/route.ts', PROGRESS = 'src/app/api/deployments/[id]/progress/route.ts';
const AWS_TEMPLATE = 'infra/bootstrap/aws/tenant-bootstrap.yaml', AZ_TEMPLATE = 'infra/bootstrap/azure/tenant-bootstrap.json';
const MODEL = 'scripts/lib/security-model.cjs', RUNNER = 'src/test/workflow-runner.ts';
const GUARD_EXIT = {find:'contains a line break."; exit 1 ;;', replace:'contains a line break." ;;'};
const CONFIG_EXIT = {find:'A value in the tenant config contains a line break."; exit 1; }', replace:'A value in the tenant config contains a line break."; }'};

const CLASSES = {
  control:{title:'Controls of the local scenarios', note:'One mutant per claim of SEC-E2E-01 to 04.'},
  regression:{title:'Regressions: the vulnerabilities this evaluation found, put back', note:'Each re-introduces a defect from *Findings* (EVALUATION.md §5) in the form it was found. A fix whose tests do not notice it being undone is not locked in.'},
  attack:{title:'The unit-level attack matrix', note:'One mutant per row of the attack-matrix table (EVALUATION.md §5) not already covered above, caught — or not — by `npm test`.'},
  harness:{title:'The harness\'s own oracles', note:'The test infrastructure is broken rather than the product. If the tests still passed, they would be passing without proving anything: an evaluator that denies everything makes every "no path to a document" test pass, so only the paired controls can catch it.'},
};

const mutants = [
  // ── control: SEC-E2E-01, tenant authorization and webhooks ─────────────
  {id:'M01', scenario:'01', control:'Redeploy checks the tenant\'s owner', changes:[{file:ACTIONS, find:'        eq(tenants.ownerUserId, session.user.id),\n', replace:'', nth:1}]},
  {id:'M02', scenario:'01', control:'Teardown checks the tenant\'s owner', changes:[{file:ACTIONS, find:'        eq(tenants.ownerUserId, session.user.id),\n', replace:'', nth:2}]},
  {id:'M03', scenario:'01', control:'Redeploy excludes deleted tenants', changes:[{file:ACTIONS, find:'        isNull(tenants.deletedAt),\n', replace:'', nth:1}]},
  {id:'M04', scenario:'01', control:'Document actions check the tenant\'s owner', changes:[{file:DOCS, find:'eq(tenants.ownerUserId, userId), ', replace:'', nth:1}]},
  {id:'M05', scenario:'01', control:'Upload authorization checks the tenant\'s owner', changes:[{file:DOCS, find:'eq(tenants.ownerUserId, userId), ', replace:'', nth:2}]},
  {id:'M06', scenario:'01', control:'Deployment API checks the tenant\'s owner', changes:[{file:PROGRESS, find:'and(eq(deployments.id, id), eq(tenants.ownerUserId, session.user.id))', replace:'eq(deployments.id, id)'}]},
  {id:'M07', scenario:'01', control:'Database allows one active deployment per tenant', changes:[{file:'drizzle/0015_one_active_deployment_per_tenant.sql', find:'CREATE UNIQUE INDEX "deployments_one_active_per_tenant" ON "deployments" USING btree ("tenant_id") WHERE "deployments"."status" IN (\'pending\', \'running\');', replace:'SELECT 1;'}]},
  {id:'M08', scenario:'01', control:'Webhook refuses a finished deployment (read check only)', expect:'survives',
    because:'The conditional UPDATE still matches only an active row, so the replay is refused with 409. M10 removes both.',
    changes:[{file:STATUS, find:'if (!isActive(deployment.status)) {', replace:'if (false) {'}]},
  {id:'M09', scenario:'01', control:'Webhook writes only to a still-active row (conditional UPDATE)', changes:[{file:STATUS, find:'.where(and(eq(deployments.id, id), inArray(deployments.status, [...ACTIVE_STATUSES])))', replace:'.where(eq(deployments.id, id))'}]},
  {id:'M10', scenario:'01', control:'Webhook: both forward-only checks (M08 + M09)', changes:[
    {file:STATUS, find:'if (!isActive(deployment.status)) {', replace:'if (false) {'},
    {file:STATUS, find:'.where(and(eq(deployments.id, id), inArray(deployments.status, [...ACTIVE_STATUSES])))', replace:'.where(eq(deployments.id, id))'}]},
  {id:'M11', scenario:'01', control:'Docs-signer URL must be this tenant\'s host (shape check only)', expect:'survives',
    because:'A URL already on record cannot be replaced, so the redirect is still refused. M12 removes both.',
    changes:[{file:'src/lib/docsSigner.ts', find:'  const problem = docsSignerUrlProblem(tenant, url);\n  if (problem) return problem;\n', replace:''}]},
  {id:'M12', scenario:'01', control:'Docs-signer URL: both checks (M11 + no-replacement)', changes:[{file:'src/lib/docsSigner.ts', find:'): string | null {\n  const problem = docsSignerUrlProblem(tenant, url);', replace:'): string | null {\n  return null;\n  const problem = docsSignerUrlProblem(tenant, url);'}]},
  {id:'M13', scenario:'01', control:'Webhook secret compared in full', changes:[{file:STATUS, find:'  if (a.length !== b.length) return false;\n  return timingSafeEqual(a, b);', replace:'  return a.length > 0;'}]},

  // ── control: SEC-E2E-02, document access ───────────────────────────────
  {id:'M14', scenario:'02', control:'AWS signer may only write and delete', changes:[{file:'infra/terraform/main.tf', find:'Action   = ["s3:PutObject", "s3:DeleteObject"]', replace:'Action   = ["s3:PutObject", "s3:DeleteObject", "s3:GetObject"]'}]},
  {id:'M15', scenario:'02', control:'Azure signer role has no blob read', changes:[{file:'infra/terraform/azure/main.tf', find:'    data_actions = [\n', replace:'    data_actions = [\n      "Microsoft.Storage/storageAccounts/blobServices/containers/blobs/read",\n', nth:1}]},
  {id:'M16', scenario:'02', control:'Onboarding role (which the platform assumes) reaches only secrets', changes:[{file:AWS_TEMPLATE,
    find:'                  - secretsmanager:UpdateSecret\n                Resource: !Sub "arn:${AWS::Partition}:secretsmanager:*:${AWS::AccountId}:secret:${TenantSlug}/*"',
    replace:'                  - secretsmanager:UpdateSecret\n                  - s3:GetObject\n                Resource: "*"'}]},
  {id:'M17', scenario:'02', control:'Platform role may assume onboarding roles only', expect:'survives',
    because:'The deployment role trusts GitHub alone, so the wider grant reaches no role that admits the platform. M18 removes both.',
    changes:[{file:'infra/platform/control-plane/main.tf', find:'resources = ["arn:aws:iam::*:role/chatbot-client-onboard-*"]', replace:'resources = ["arn:aws:iam::*:role/chatbot-client-*"]'}]},
  {id:'M18', scenario:['02', '03'], control:'Platform role scope and deployment-role trust (M17 + platform trusted)', changes:[
    {file:'infra/platform/control-plane/main.tf', find:'resources = ["arn:aws:iam::*:role/chatbot-client-onboard-*"]', replace:'resources = ["arn:aws:iam::*:role/chatbot-client-*"]'},
    {file:AWS_TEMPLATE, find:'          - Sid: GitHubActionsDeploy\n', replace:'          - Sid: PlatformBackdoor\n            Effect: Allow\n            Principal:\n              AWS: !Sub "arn:${AWS::Partition}:iam::${PlatformAccountId}:root"\n            Action: sts:AssumeRole\n          - Sid: GitHubActionsDeploy\n'}]},

  // ── control: SEC-E2E-03, identity isolation ────────────────────────────
  {id:'M19', scenario:'03', control:'Deployment role matches the GitHub subject exactly', changes:[
    {file:AWS_TEMPLATE, find:'              StringEquals:\n                token.actions.githubusercontent.com:aud: sts.amazonaws.com', replace:'              StringLike:\n                token.actions.githubusercontent.com:aud: sts.amazonaws.com'},
    {file:AWS_TEMPLATE, find:':environment:tenant-${TenantId}"', replace:':environment:tenant-*"', nth:1}]},
  {id:'M20', scenario:'03', control:'Onboarding role requires this tenant\'s ExternalId', changes:[{file:AWS_TEMPLATE, find:'            Condition:\n              StringEquals:\n                sts:ExternalId: !Ref TenantId\n', replace:''}]},
  {id:'M21', scenario:'03', control:'Azure federated credential names the tenant\'s environment', changes:[{file:AZ_TEMPLATE, find:"repo:{0}/{1}:environment:tenant-{2}', parameters('gitHubOwner'), parameters('gitHubRepo'), parameters('chatbotId')", replace:"repo:{0}/{1}:ref:refs/heads/main', parameters('gitHubOwner'), parameters('gitHubRepo')"}]},
  {id:'M22', scenario:'03', control:'Secrets release checks the token\'s subject', changes:[{file:'src/lib/deploymentSecrets.ts', find:'if (claims.sub !== tenantDeploySubject(repo, tenant.id)) {', replace:'if (false) {'}]},
  {id:'M23', scenario:'03', control:'Secrets release checks the workflow and ref', changes:[{file:'src/lib/deploymentSecrets.ts', find:'if (claims.workflow_ref !== workflowRef(repo, workflow, deployRef())) {', replace:'if (false) {'}]},
  {id:'M24', scenario:'03', control:'Secrets release checks the repository', changes:[{file:'src/lib/deploymentSecrets.ts', find:'if (claims.repository !== `${repo.owner}/${repo.repo}`) {', replace:'if (false) {'}]},
  {id:'M25', scenario:'03', control:'Secrets are released once per deployment', changes:[{file:'src/lib/deploymentSecrets.ts', find:'        isNull(deployments.secretsClaimedAt),\n', replace:''}]},

  // ── control: SEC-E2E-04, workflow integrity ────────────────────────────
  {id:'M26', scenario:'04', filter:'line-break guard', control:'Deploy refuses inputs containing line breaks', changes:[{file:'.github/workflows/deploy-tenant.yml', ...GUARD_EXIT}]},
  {id:'M27', scenario:'04', filter:'a line break in config', control:'Azure config parser refuses line breaks', changes:[{file:'.github/workflows/deploy-tenant-azure.yml', ...CONFIG_EXIT}]},
  {id:'M28', scenario:'04', filter:'no script is built from an input|well-formed config flows', control:'Inputs reach scripts only through env:', changes:[{file:'.github/workflows/deploy-tenant-azure.yml', find:"          echo \"$CONFIG_JSON\" | jq -e 'has(", replace:"          echo '${{ inputs.config }}' | jq -e 'has("}]},
  {id:'M29', scenario:'04', filter:'shell payload in your_ecr_image', control:'Inputs are quoted, never evaluated', changes:[{file:'.github/workflows/deploy-tenant.yml', find:'docker tag "$IN_YOUR_ECR_IMAGE" "$BACKEND_URI"', replace:'eval docker tag $IN_YOUR_ECR_IMAGE $BACKEND_URI'}]},
  {id:'M30', scenario:'04', filter:'line-break guard', control:'AWS teardown refuses inputs containing line breaks', changes:[{file:'.github/workflows/destroy-tenant.yml', ...GUARD_EXIT}]},

  // ── regression: each finding, as it was found ──────────────────────────
  {id:'R01', class:'regression', unit:['src/lib/tenantInput.test.ts'], control:'#16 Free-text dispatch fields accept any character again (chatbot version, model, Azure region)', changes:[
    {file:'src/lib/tenantInput.ts', find:'    .regex(IMAGE_TAG_RE, "Must be an image tag: letters, numbers, \'.\', \'_\' and \'-\', up to 128 characters")\n', replace:'    .min(1)\n'},
    {file:'src/lib/tenantInput.ts', find:'    .regex(MODEL_ID_RE, "Must be a model ID, such as gpt-4o-mini or meta-llama/llama-3.3-70b-instruct:free")\n', replace:''},
    {file:'src/lib/tenantInput.ts', find:'\n    .regex(AZURE_REGION_RE, "Must be a region name as Azure lists it, e.g. swedencentral")', replace:''}]},
  {id:'R02', class:'regression', unit:['src/lib/crypto.test.ts'], control:'#17 decryptSecret accepts an authentication tag shorter than 16 bytes', changes:[
    {file:'src/lib/crypto.ts', find:'if (iv.length !== IV_LENGTH || tag.length !== TAG_LENGTH) {', replace:'if (iv.length !== IV_LENGTH) {'},
    {file:'src/lib/crypto.ts', find:'createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_LENGTH })', replace:'createDecipheriv(ALGORITHM, key, iv)'}]},
  {id:'R03', class:'regression', unit:['src/lib/crypto.test.ts'], control:'#17 decryptSecret ignores a fourth blob segment', changes:[{file:'src/lib/crypto.ts', find:'parts.length !== 3 || ', replace:''}]},
  {id:'R04', class:'regression', unit:['src/app/tenantIsolation.test.ts'], control:'S10.5 A connection check may name another operator\'s tenant', changes:[{file:'src/app/tenants/connectionActions.ts', find:'if (owner && owner.ownerUserId !== session.user.id) {', replace:'if (false) {'}]},
  {id:'R05', class:'regression', scenario:'04', filter:'line-break guard|a line break in config', control:'#16 Azure deploy workflow as found: no line-break guard and no parser check', changes:[
    {file:'.github/workflows/deploy-tenant-azure.yml', ...GUARD_EXIT}, {file:'.github/workflows/deploy-tenant-azure.yml', ...CONFIG_EXIT}]},
  {id:'R06', class:'regression', scenario:'04', filter:'line-break guard|teardown\'s config parser', control:'#16 Azure teardown workflow as found: no line-break guard and no parser check', changes:[
    {file:'.github/workflows/destroy-tenant-azure.yml', ...GUARD_EXIT}, {file:'.github/workflows/destroy-tenant-azure.yml', ...CONFIG_EXIT}]},

  // ── attack: the unit-level attack matrix ───────────────────────────────
  {id:'A01', class:'attack', unit:['src/lib/deploymentSecrets.test.ts'], control:'OIDC: the token\'s audience is checked', changes:[{file:'src/lib/deploymentSecrets.ts', find:'      audience: PLATFORM_SECRETS_AUDIENCE,\n', replace:''}]},
  {id:'A02', class:'attack', unit:['src/lib/deploymentSecrets.test.ts'], control:'OIDC: the token\'s issuer is checked', changes:[{file:'src/lib/deploymentSecrets.ts', find:'      issuer: GITHUB_OIDC_ISSUER,\n', replace:''}]},
  {id:'A03', class:'attack', unit:['src/lib/deploymentSecrets.test.ts'], control:'OIDC: the claims that identify a run must be strings', changes:[{file:'src/lib/deploymentSecrets.ts', find:'    throw new SecretsRequestError(401, "The OIDC token is missing the claims that identify a workflow run.");', replace:'    void 0;'}]},
  {id:'A04', class:'attack', unit:['src/app/api/deployments/[id]/status/route.test.ts'], control:'Webhook: no secret configured means no callback is accepted', changes:[{file:STATUS, find:'  if (!expected) return false;\n', replace:''}]},
  {id:'A05', class:'attack', unit:['src/app/api/deployments/[id]/status/route.test.ts'], control:'Webhook: a run can never move a deployment back to pending', changes:[{file:STATUS, find:'status: z.enum(["running", "succeeded", "failed", "cancelled"]),', replace:'status: z.enum(["pending", "running", "succeeded", "failed", "cancelled"]),'}]},
  {id:'A06', class:'attack', unit:['src/auth.test.ts'], control:'Proxy: only the two callback routes pass unauthenticated', changes:[{file:'src/auth.ts', find:'const WEBHOOK_PATH = /^\\/api\\/deployments\\/[^/]+\\/(status|secrets)\\/?$/;', replace:'const WEBHOOK_PATH = /\\/api\\/deployments\\/.+\\/(status|secrets)/;'}]},
  {id:'A07', class:'attack', unit:['src/auth.test.ts'], control:'Sign-in stores no GitHub token', changes:[{file:'src/auth.ts', find:'      account: () => undefined,\n', replace:''}]},
  {id:'A08', class:'attack', unit:['src/lib/tenantErasure.test.ts'], control:'Teardown erases every encrypted column', changes:[{file:'src/lib/tenantErasure.ts', find:'    docsSignerSecretEncrypted: null,\n', replace:''}]},

  // ── harness: the oracles themselves ────────────────────────────────────
  {id:'H01', class:'harness', scenario:['02', '03'], control:'IAM evaluator applies Condition blocks (ignoring them would admit any ExternalId and subject)', changes:[{file:MODEL, find:'function conditionsHold(condition, context){\n', replace:'function conditionsHold(condition, context){\n  return true;\n'}]},
  {id:'H02', class:'harness', scenario:['02', '03'], control:'IAM evaluator can answer Allow (one that only denies makes every denial test pass)', changes:[{file:MODEL, find:"return allow.length ? {decision:'Allow', statements:allow.map(s => s.Sid)} : {decision:'ImplicitDeny', statements:[]};", replace:"return {decision:'ImplicitDeny', statements:[]};"}]},
  {id:'H03', class:'harness', scenario:'03', control:'Entra matcher can accept a token (one that refuses all makes every refusal test pass)', changes:[{file:MODEL, find:'  return token.iss === credential.issuer && token.sub === credential.subject && credential.audiences.includes(token.aud);', replace:'  return false;'}]},
  {id:'H04', class:'harness', scenario:'04', filter:'line-break guard|a line break in config|control', control:'Workflow runner executes the committed step script', changes:[{file:RUNNER, find:'writeFileSync(script, evaluate(step.run, ctx).replace(/\\r\\n/g, "\\n"));', replace:'writeFileSync(script, "exit 0\\n");'}]},
].map(m => ({class:'control', ...m}));

// ── Apply and restore ────────────────────────────────────────────────────
const originals = new Map();
function restoreAll(){ for(const [file, content] of originals) fs.writeFileSync(file, content); originals.clear(); }
for(const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { restoreAll(); process.exit(130); });
process.on('exit', restoreAll);

function apply(m, {dryRun = false} = {}){
  for(const c of m.changes){
    if(!dryRun && !originals.has(c.file)) originals.set(c.file, fs.readFileSync(c.file));
    const text = fs.readFileSync(c.file, 'utf8');
    const crlf = text.includes('\r\n');
    const find = crlf ? c.find.replace(/\n/g, '\r\n') : c.find, replace = crlf ? c.replace.replace(/\n/g, '\r\n') : c.replace;
    const at = []; for(let i = text.indexOf(find); i >= 0; i = text.indexOf(find, i + 1)) at.push(i);
    const nth = c.nth ?? 1;
    // A mutant whose anchor no longer exists, or is ambiguous, is reported
    // rather than silently skipped: the code moved and the mutant must follow.
    if(at.length < nth || (c.nth === undefined && at.length !== 1)) throw new Error(`${m.id}: anchor found ${at.length}× in ${c.file}`);
    const i = at[nth - 1];
    if(!dryRun) fs.writeFileSync(c.file, text.slice(0, i) + replace + text.slice(i + find.length));
  }
}

// One vitest invocation. `related` runs every test file that imports the
// given source, which for in-process tests is every test that could notice it.
const RUN_TIMEOUT_MS = 15 * 60_000;
function vitest({config, files = [], related = null, filter, bail}){
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sec-mut-')), 'vitest.json');
  const run = spawnSync(process.execPath, ['node_modules/vitest/vitest.mjs', ...(related ? ['related', ...related, '--run'] : ['run', ...files]), '--config', config,
    ...(filter ? ['-t', filter] : []), ...(bail ? ['--bail', '1'] : []), '--reporter=json', `--outputFile.json=${out}`], {stdio:'ignore', timeout:RUN_TIMEOUT_MS});
  if(run.error?.code === 'ETIMEDOUT') return {timedOut:true, total:0, passed:0, failed:[], loadErrors:[]};
  if(!fs.existsSync(out)) return {error:'vitest produced no results', total:0, passed:0, failed:[], loadErrors:[]};
  const r = JSON.parse(fs.readFileSync(out, 'utf8'));
  fs.rmSync(path.dirname(out), {recursive:true, force:true});
  const failed = r.testResults.flatMap(f => f.assertionResults.filter(a => a.status === 'failed').map(a => [...a.ancestorTitles, a.title].join(' > ')));
  const loadErrors = r.testResults.filter(f => f.status === 'failed' && f.assertionResults.length === 0).map(f => f.message);
  return {total:r.numTotalTests, passed:r.numPassedTests, failed, loadErrors};
}

// The groups of tests a mutant is run against, in order; the first that kills it ends the run.
function groupsOf(m){
  if(m.generated) return [{config:UNIT, related:[m.file], bail:true}, {config:E2E, related:[m.file], bail:true}];
  return [
    ...(m.unit ? [{config:UNIT, files:m.unit}] : []),
    ...(m.scenario ? [{config:E2E, files:[m.scenario].flat().map(s => S[s]), filter:m.filter}] : []),
  ];
}

function runMutant(m){
  let outcome, detail = {total:0, failed:[], loadErrors:[]}, caughtBy = null;
  try{
    apply(m);
    for(const g of groupsOf(m)){
      const r = vitest(g);
      detail = {total:detail.total + r.total, failed:[...detail.failed, ...r.failed], loadErrors:[...detail.loadErrors, ...r.loadErrors], error:r.error};
      if(r.timedOut){ outcome = 'timeout'; caughtBy = g.config; break; }
      if(r.error || r.loadErrors.length){ outcome = 'error'; break; }
      if(r.failed.length){ outcome = 'killed'; caughtBy = g.config === UNIT ? 'unit tests' : 'security scenarios'; break; }
    }
    outcome ??= detail.total ? 'survived' : 'error';
  }catch(err){
    outcome = 'invalid'; detail = {error:err.message, failed:[], loadErrors:[]};
  }finally{
    restoreAll();
  }
  return {outcome, caughtBy, testsRun:detail.total, killingTests:detail.failed, error:detail.error ?? detail.loadErrors?.[0] ?? (detail.total ? null : 'no tests ran')};
}

// ── Select ───────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const option = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const generatedMode = args.includes('--generated');
const ids = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--class');
const klass = option('--class');
const pool = generatedMode ? generatedMutants().map(m => ({...m, generated:true, class:'generated', control:m.what})) : mutants;
const selected = pool.filter(m => (!ids.length || ids.includes(m.id)) && (!klass || m.class === klass));
const complete = !ids.length && !klass;

if(args.includes('--check')){
  let bad = 0;
  for(const m of [...mutants, ...generatedMutants()].filter(m => !ids.length || ids.includes(m.id))){
    try{ apply(m, {dryRun:true}); if(!m.operator) console.log(`${m.id}  ok`); }catch(err){ bad++; console.log(`${m.id}  ${err.message}`); }
  }
  console.log(`${generatedMutants().length} generated mutants resolve${bad ? `; ${bad} anchor(s) failed` : ''}`);
  process.exit(bad ? 1 : 0);
}
if(args.includes('--list')){
  for(const m of selected) console.log(`${m.id}  ${m.class.padEnd(10)} ${m.file ? `${m.file}:${m.line}  ` : ''}${m.control}`);
  process.exit(0);
}
if(!selected.length){ console.error('No mutant matches.'); process.exit(1); }

const sha = file => require('node:crypto').createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const touched = [...new Set([...mutants, ...generatedMutants()].flatMap(m => m.changes.map(c => c.file)))];
const fingerprint = new Map(touched.map(f => [f, sha(f)]));

// ── Baseline: unmutated, every test the mutants will be run against passes ─
console.log('Baseline: every test the mutants use must pass unmutated …');
const baseline = [vitest({config:UNIT}), vitest({config:E2E, files:generatedMode ? [S['01'], S['02'], S['03']] : Object.values(S)})];
const base = {passed:baseline.reduce((n, r) => n + r.passed, 0), total:baseline.reduce((n, r) => n + r.total, 0)};
if(baseline.some(r => r.error || r.timedOut || r.failed.length || r.loadErrors.length || !r.total)){
  console.error('Baseline failed; mutation results would be meaningless.', baseline.map(r => ({...r, failed:r.failed.slice(0, 5)})));
  process.exit(1);
}
console.log(`  ${base.passed}/${base.total} passed\n`);

// ── Run ──────────────────────────────────────────────────────────────────
const results = [];
const started = Date.now();
for(const [n, m] of selected.entries()){
  const expect = m.expect ?? 'killed';
  const r = runMutant(m);
  const detected = r.outcome === 'killed' || r.outcome === 'timeout';
  const asExpected = (detected && expect === 'killed') || (r.outcome === 'survived' && expect === 'survives');
  results.push({id:m.id, class:m.class, scenario:m.scenario ? [m.scenario].flat().map(s => `SEC-E2E-${s}`).join(', ') : null, unit:m.unit ?? null,
    control:m.control, expect, because:m.because ?? null, ...r, asExpected, targets:[...new Set(m.changes.map(c => c.file))],
    ...(m.generated ? {file:m.file, line:m.line, operator:m.operator, scope:m.scope, before:m.before, after:m.after, fingerprint:m.fingerprint} : {})});
  const eta = selected.length > 20 ? `  [${n + 1}/${selected.length}, ${Math.round((Date.now() - started) / 60000)} min]` : '';
  console.log(`${m.id}  ${r.outcome.padEnd(8)} ${asExpected || m.generated ? '   ' : ' ✗ '} ${m.generated ? `${m.file.split('/').slice(-2).join('/')}:${m.line} ` : ''}${m.control}${eta}`);
}

// Every file must be exactly as it was before the first mutant.
const changedAfter = [...fingerprint].filter(([file, hash]) => sha(file) !== hash).map(([file]) => file);
if(changedAfter.length){ console.error(`NOT RESTORED: ${changedAfter.join(', ')}`); process.exit(2); }

// ── Archive ──────────────────────────────────────────────────────────────
const git = cmd => { try { return execSync(cmd, {encoding:'utf8', stdio:['ignore','pipe','ignore']}).trim(); } catch { return ''; } };
const run = {generated:new Date().toISOString(), commit:git('git rev-parse --short=12 HEAD'), dirty:git('git status --porcelain --untracked-files=no').length > 0,
  node:process.version, baseline:base, minutes:Math.round((Date.now() - started) / 6000) / 10};
// A generated mutant has no expectation to miss: its survivors are reviewed, not predicted.
const unexpected = results.filter(r => !r.asExpected && r.class !== 'generated');

if(complete && generatedMode){
  const killed = results.filter(r => r.outcome === 'killed' || r.outcome === 'timeout').length, valid = results.filter(r => r.outcome !== 'invalid' && r.outcome !== 'error');
  fs.writeFileSync(path.join(dir, 'generated.json'), JSON.stringify({...run, sources:SOURCES, score:{killed, of:valid.length},
    errors:results.filter(r => r.outcome === 'error' || r.outcome === 'invalid').map(r => r.id), mutants:results}, null, 2) + '\n');
}else if(complete){
  const mustKill = results.filter(r => r.expect === 'killed'), layered = results.filter(r => r.expect === 'survives');
  const byClass = Object.fromEntries(Object.keys(CLASSES).map(k => [k, {
    killed:results.filter(r => r.class === k && r.expect === 'killed' && (r.outcome === 'killed' || r.outcome === 'timeout')).length,
    of:results.filter(r => r.class === k && r.expect === 'killed').length}]));
  fs.writeFileSync(path.join(dir, 'results.json'), JSON.stringify({...run,
    score:{killed:mustKill.filter(r => r.outcome === 'killed' || r.outcome === 'timeout').length, of:mustKill.length}, byClass,
    layeredSurvivors:layered.filter(r => r.outcome === 'survived').length, unexpected:unexpected.map(r => r.id), mutants:results}, null, 2) + '\n');
}
if(complete) writeReport();
else console.log('\nA partial run: results printed only, docs/evaluation/security-mutation left as it was.');

const detectedCount = results.filter(r => r.outcome === 'killed' || r.outcome === 'timeout').length;
console.log(`\n${detectedCount}/${results.length} killed; unexpected: ${unexpected.map(r => r.id).join(', ') || 'none'}`);
process.exit(unexpected.length ? 1 : 0);

// ── Report ───────────────────────────────────────────────────────────────
function writeReport(){
  const load = f => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { return null; } };
  const hand = load('results.json'), gen = load('generated.json'), triage = load('generated-triage.json') ?? {};
  const cell = s => String(s ?? '—').replace(/\|/g, '\\|');
  const caught = r => r.outcome === 'killed' ? `${r.killingTests.length} test(s), e.g. ${cell(r.killingTests[0].split(' > ').slice(-1)[0])}` : r.outcome === 'timeout' ? 'timed out (counted as detected)' : cell(r.because ?? r.error ?? '—');
  const md = ['# Security mutation testing', ''];
  if(hand){
    md.push(`Hand-written mutants: generated ${hand.generated} by \`npm run evaluate:security:mutants\` at commit \`${hand.commit}\`${hand.dirty ? ' with uncommitted changes' : ''}, Node ${hand.node}, ${hand.minutes} min. Baseline: ${hand.baseline.passed}/${hand.baseline.total} tests passed unmutated.`, '',
      'Each mutant removes or weakens one control in the real source, template, workflow or test harness; the tests meant to catch it are then run. **Killed** means at least one test failed. Mutants marked *layered* are expected to survive because a second, independent control still blocks the attack; each is paired with a mutant that removes both layers. Expectations are fixed in the script before the run.', '',
      `**Mutation score: ${hand.score.killed}/${hand.score.of}** of the mutants that must be killed were killed. Layered mutants that survived as expected: ${hand.layeredSurvivors}/${hand.mutants.filter(r => r.expect === 'survives').length}. Unexpected outcomes: ${hand.unexpected.length ? hand.unexpected.join(', ') : 'none'}.`, '',
      '| Class | Killed |', '|---|---|', ...Object.entries(hand.byClass ?? {}).map(([k, v]) => `| ${CLASSES[k]?.title ?? k} | ${v.killed}/${v.of} |`), '');
    for(const [k, c] of Object.entries(CLASSES)){
      const rows = hand.mutants.filter(r => (r.class ?? 'control') === k); if(!rows.length) continue;
      md.push(`## ${c.title}`, '', c.note, '', '| ID | Run against | Control removed or weakened | Expected | Outcome | Caught by |', '|---|---|---|---|---|---|',
        ...rows.map(r => `| ${r.id} | ${cell([r.scenario, r.unit && r.unit.map(u => `\`${path.basename(u)}\``).join(', ')].filter(Boolean).join('; '))} | ${cell(r.control)} | ${r.expect === 'survives' ? 'survives (layered)' : 'killed'} | **${r.outcome}**${r.asExpected ? '' : ' ✗'} | ${caught(r)} |`), '');
    }
  }
  if(gen){
    const survivors = gen.mutants.filter(r => r.outcome === 'survived');
    const verdict = r => triage[r.fingerprint]?.verdict ?? 'unreviewed';
    const counts = survivors.reduce((a, r) => (a[verdict(r)] = (a[verdict(r)] ?? 0) + 1, a), {});
    const ops = [...new Set(gen.mutants.map(r => r.operator))];
    md.push('## Generated mutants', '', `Generated ${gen.generated} by \`npm run evaluate:security:mutants -- --generated\` at commit \`${gen.commit}\`${gen.dirty ? ' with uncommitted changes' : ''}, ${gen.minutes} min. Baseline: ${gen.baseline.passed}/${gen.baseline.total} tests passed unmutated.`, '',
      `Nobody chose these. Every guard (an \`if\` that returns, throws or redirects), every alternative of such a guard's \`||\`, every condition of a drizzle \`and(...)\` and every zod refinement in ${gen.sources.length} security-critical files became one mutant (\`scripts/lib/generated-mutants.cjs\`). Each was run against every unit test and security scenario that imports its file (\`vitest related\`), stopping at the first failure. A survivor is equivalent, held by another layer, outside the security claims, or a gap in the tests; each is reviewed in \`generated-triage.json\`.`, '',
      `**Generated mutation score: ${gen.score.killed}/${gen.score.of}** (${Math.round(100 * gen.score.killed / gen.score.of)}%).${gen.errors.length ? ` ${gen.errors.length} could not be run: ${gen.errors.join(', ')}.` : ''} Survivors: ${survivors.length}${survivors.length ? ` — ${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ')}` : ''}.`, '',
      ...(() => { const closed = Object.values(triage).filter(t => t.verdict === 'closed'); return closed.length ? [`${closed.length} further mutants survived an earlier generated run and were killed once tests were added for the gaps they exposed: ${closed.map(t => t.id).join(', ')}. Each names its test in \`generated-triage.json\`.`, ''] : []; })(),
      '| Operator | Mutants | Killed | Survived |', '|---|---:|---:|---:|',
      ...ops.map(o => { const rs = gen.mutants.filter(r => r.operator === o); return `| ${o} | ${rs.length} | ${rs.filter(r => r.outcome === 'killed' || r.outcome === 'timeout').length} | ${rs.filter(r => r.outcome === 'survived').length} |`; }),
      '', '| File | Mutants | Killed |', '|---|---:|---:|',
      ...gen.sources.map(f => { const rs = gen.mutants.filter(r => r.file === f); return rs.length ? `| \`${f}\` | ${rs.length} | ${rs.filter(r => r.outcome === 'killed' || r.outcome === 'timeout').length} |` : null; }).filter(Boolean), '');
    if(survivors.length) md.push('### Survivors', '', '| ID | Where | Mutation | Verdict | Why |', '|---|---|---|---|---|',
      ...survivors.map(r => `| ${r.id} | \`${r.file.replace(/^src\//, '')}:${r.line}\` (${cell(r.scope)}) | ${cell(r.control)} | **${verdict(r)}** | ${cell(triage[r.fingerprint]?.note ?? 'not yet reviewed')} |`), '');
  }
  fs.writeFileSync(path.join(dir, 'REPORT.md'), md.join('\n'));
  console.log(`Wrote ${dir}/REPORT.md`);
}
