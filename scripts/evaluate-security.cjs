/* eslint-disable @typescript-eslint/no-require-imports -- Standalone CommonJS evaluation script. */
// Security evaluation (EVALUATION.md §5): turns the claims in SECURITY.md and
// ARCHITECTURE.md into pass/fail tests with recorded evidence.
//
//   node scripts/evaluate-security.cjs [--target https://<platform host>] [--skip-docker] [--skip-logs]
//
// Read-only against the database, GitHub and every cloud account. The live tests
// (--target) send forged requests that the platform must refuse; the one request
// carrying the real webhook secret targets a deployment that has already finished,
// and the row is compared before and after.
//
// Writes docs/evaluation/security/: REPORT.md, results.json and each scanner's output.
// Needs Docker for gitleaks, Checkov and zizmor, which run pinned images.
const fs = require('node:fs'); const path = require('node:path'); const os = require('node:os'); const crypto = require('node:crypto');
const {spawnSync} = require('node:child_process');
const dotenv = require('dotenv'); dotenv.config({path:'.env.local',quiet:true}); dotenv.config({quiet:true});
const {neon} = require('@neondatabase/serverless');
const YAML = require('yaml');
const AdmZip = require('adm-zip');

const dir = 'docs/evaluation/security'; fs.mkdirSync(dir,{recursive:true});
const work = path.join(os.tmpdir(),'chatbot-security-eval'); fs.mkdirSync(work,{recursive:true});
const args = process.argv.slice(2);
const has = name => args.includes(name);
const option = name => { const i = args.indexOf(name); return i >= 0 ? args[i+1] : undefined; };
const images = {gitleaks:'zricethezav/gitleaks:v8.30.1', checkov:'bridgecrew/checkov:3.3.19', zizmor:'ghcr.io/zizmorcore/zizmor:1.30.1'};
const owner = process.env.CHATBOT_REPO_OWNER, repo = process.env.CHATBOT_REPO_NAME;
const read = file => fs.readFileSync(file,'utf8');
const mask = text => String(text).replace(/\b\d{12}\b/g,'<account>');
const results = [];
function record(test){ results.push(test); console.log(`${test.id.padEnd(4)} ${test.cloud.padEnd(5)} ${test.result.padEnd(12)} ${test.claim}`); }
// file:line of the first matching line, so every piece of static evidence can be checked by hand.
function at(file, pattern){ const i = read(file).split(/\r?\n/).findIndex(line => pattern.test(line)); return i < 0 ? `${file} (no line matches ${pattern})` : `${file}:${i+1}`; }
function walk(root, keep){ return fs.readdirSync(root,{withFileTypes:true}).flatMap(e => { const p = path.join(root,e.name); return e.isDirectory() ? walk(p, keep) : keep(p) ? [p] : []; }); }

// The IAM evaluator and the bootstrap template renderer are shared with the
// local end-to-end scenarios (src/security-e2e), so both evaluate one model.
const {evaluate, block, awsTemplateFile, sampleTenant, renderAwsBootstrap, controlPlaneFile, controlPlaneSource, keyPatterns} = require('./lib/security-model.cjs');
const sample = sampleTenant({tenantId:'7d6c1f9e-5b1a-4c3e-9f00-00000000a11c', slug:'acme', owner, repo});
const awsTemplate = renderAwsBootstrap(sample);
const deployRole = awsTemplate.DeploymentRole.Properties;
const deployTrust = deployRole.AssumeRolePolicyDocument.Statement;
const deployPolicy = deployRole.Policies.flatMap(p => p.PolicyDocument.Statement);
const deployRoleArn = `arn:aws:iam::${sample['AWS::AccountId']}:role/${deployRole.RoleName}`;
const docsBucket = `arn:aws:s3:::chatbot-${sample.TenantSlug}-docs`;

// The platform application's AWS role, twice: as written in the source, and as
// deployed (the operator's local Terraform state) when that is available. The
// claim has to hold for both, and a difference means an apply is outstanding.
function controlPlaneDeployed(){
  const state = 'infra/platform/control-plane/terraform.tfstate';
  if(!fs.existsSync(state)) return null;
  const s = JSON.parse(read(state));
  const attributes = (type, name) => s.resources.find(r => r.type === type && r.name === name)?.instances[0]?.attributes;
  const policy = attributes('aws_iam_role_policy','control_plane'), role = attributes('aws_iam_role','control_plane');
  return policy && role ? {source:`${state} (deployed, state serial ${s.serial})`, name:role.name, permissions:JSON.parse(policy.policy).Statement, trust:JSON.parse(role.assume_role_policy).Statement} : null;
}

// Every role in the bootstrap template is a candidate way in. A path to the
// documents needs all of: the platform's policy lets it call AssumeRole on the
// role, the role's trust admits the platform with this tenant's ExternalId,
// and the role's own policies allow reading. The claim holds when no role
// completes the path.
function testS2Aws(){
  const source = controlPlaneSource(), deployed = controlPlaneDeployed();
  const platformRole = `arn:aws:iam::${sample.PlatformAccountId}:role/${deployed?.name ?? 'platform-control-plane'}`;
  const mayAssume = arn => {
    const decisions = [source, deployed].filter(Boolean).map(cp => evaluate(cp.permissions, {action:'sts:AssumeRole', resource:arn}));
    return decisions.find(d => d.decision === 'Allow') ?? decisions[0];
  };
  const assumeEvidence = arn => [source, deployed].filter(Boolean).map(cp => `${cp.source}: ${evaluate(cp.permissions, {action:'sts:AssumeRole', resource:arn}).decision}`).join('; ');
  const roles = Object.entries(awsTemplate).filter(([, r]) => r.Type === 'AWS::IAM::Role');
  const paths = roles.map(([id, role]) => {
    const name = role.Properties.RoleName, arn = `arn:aws:iam::${sample['AWS::AccountId']}:role/${name}`;
    const trust = role.Properties.AssumeRolePolicyDocument.Statement;
    const policy = (role.Properties.Policies || []).flatMap(p => p.PolicyDocument.Statement);
    if(role.Properties.ManagedPolicyArns || role.Properties.PermissionsBoundary) throw new Error(`${id} has managed policies or a boundary, which the evaluator does not model`);
    const roleLine = at(awsTemplateFile, new RegExp(`^  ${id}:`));
    const links = [
      {step:`The platform role may call sts:AssumeRole on ${name}`, outcome:mayAssume(arn), evidence:assumeEvidence(arn)},
      {step:`${name} trusts the platform account when it sends the tenant ID as ExternalId`, outcome:evaluate(trust, {action:'sts:AssumeRole', caller:{AWS:platformRole}, context:{'sts:ExternalId':sample.TenantId}}), evidence:roleLine},
      {step:`${name} may read a document`, outcome:evaluate(policy, {action:'s3:GetObject', resource:`${docsBucket}/contract.pdf`}), evidence:roleLine},
      {step:`${name} may list the documents bucket`, outcome:evaluate(policy, {action:'s3:ListBucket', resource:docsBucket}), evidence:roleLine},
    ];
    // Reading or listing alone is enough to expose documents.
    const complete = links[0].outcome.decision === 'Allow' && links[1].outcome.decision === 'Allow' && [links[2], links[3]].some(l => l.outcome.decision === 'Allow');
    return {role:name, links, complete};
  });
  const onboarding = awsTemplate.OnboardingRole;
  const onboardingPolicy = onboarding ? onboarding.Properties.Policies.flatMap(p => p.PolicyDocument.Statement) : [];
  const onboardingTrust = onboarding ? onboarding.Properties.AssumeRolePolicyDocument.Statement : deployTrust;
  const secret = `arn:aws:secretsmanager:${sample['AWS::Region']}:${sample['AWS::AccountId']}:secret:${sample.TenantSlug}/llm-api-key-AbCdEf`;
  const controls = [
    {step:'Another tenant\'s ExternalId is refused', outcome:evaluate(onboardingTrust, {action:'sts:AssumeRole', caller:{AWS:platformRole}, context:{'sts:ExternalId':'00000000-0000-4000-8000-000000000000'}})},
    {step:'A request without ExternalId is refused', outcome:evaluate(onboardingTrust, {action:'sts:AssumeRole', caller:{AWS:platformRole}})},
    {step:'A principal in another AWS account is refused', outcome:evaluate(onboardingTrust, {action:'sts:AssumeRole', caller:{AWS:'arn:aws:iam::333333333333:role/someone'}, context:{'sts:ExternalId':sample.TenantId}})},
    {step:'The platform role may not assume an unrelated role', outcome:mayAssume('arn:aws:iam::111111111111:role/OrganizationAccountAccessRole')},
    {step:'The deployment role may not edit its own IAM role', outcome:evaluate(deployPolicy, {action:'iam:PutRolePolicy', resource:deployRoleArn})},
    ...(onboarding ? [
      {step:'The onboarding role may not read a secret back', outcome:evaluate(onboardingPolicy, {action:'secretsmanager:GetSecretValue', resource:secret})},
      {step:'The deployment role may not widen the onboarding role', outcome:evaluate(deployPolicy, {action:'iam:PutRolePolicy', resource:`arn:aws:iam::${sample['AWS::AccountId']}:role/${onboarding.Properties.RoleName}`})},
    ] : []),
  ];
  // The fix must not break onboarding: the role the platform uses still has to
  // be able to store the tenant's keys.
  const functional = onboarding ? [
    {step:'The platform role may assume the onboarding role', outcome:mayAssume(`arn:aws:iam::${sample['AWS::AccountId']}:role/${onboarding.Properties.RoleName}`)},
    {step:'The onboarding role may create this tenant\'s secret', outcome:evaluate(onboardingPolicy, {action:'secretsmanager:CreateSecret', resource:secret})},
  ] : [];
  const bucketPolicy = /resource "aws_s3_bucket_policy"[^{]*\{[^}]*aws_s3_bucket\.docs\./.test(read('infra/terraform/main.tf'));
  const drift = deployed && JSON.stringify(deployed.permissions.map(s => [s.Action, s.Resource].flat())) !== JSON.stringify(source.permissions.map(s => [s.Action, s.Resource].flat()));
  const holders = (deployed?.trust ?? []).map(s => `${s.Sid}: ${mask(JSON.stringify(s.Principal))}${s.Condition ? ` when ${mask(JSON.stringify(s.Condition))}` : ''}`);
  const reaching = paths.filter(p => p.complete);
  const controlsHold = controls.every(c => c.outcome.decision !== 'Allow');
  record({id:'S2', cloud:'aws', claim:'The platform holds no credential able to read a tenant document',
    method:'Static IAM evaluation of every role in the bootstrap template against the control-plane policy as written and as deployed, rendered for a sample tenant; negative controls throughout',
    result:!controlsHold ? 'INCONCLUSIVE' : reaching.length ? 'FAIL' : 'PASS',
    summary:reaching.length
      ? `The platform can reach the documents through ${reaching.map(p => p.role).join(' and ')}: it may assume the role, the role trusts it with the tenant ID as ExternalId, and the role may read the bucket. The trust has no time bound, so this lasts as long as the bootstrap stack does.`
      : `No role completes the path. The role the platform may assume (${paths.filter(p => p.links[0].outcome.decision === 'Allow' && p.links[1].outcome.decision === 'Allow').map(p => p.role).join(', ') || 'none'}) cannot read the bucket, and every role that can read it refuses the platform.`,
    paths, controls, functional, holders,
    evidence:[
      `Documents bucket policy: ${bucketPolicy ? 'declared in infra/terraform/main.tf — not modelled' : 'none declared (infra/terraform/main.tf), so no resource policy changes these decisions'}`,
      drift ? `The deployed control-plane policy differs from ${controlPlaneFile}: apply it, or onboarding cannot assume the new role.` : deployed ? 'The deployed control-plane policy matches the source.' : 'No local state for the control-plane role; the source policy alone was evaluated.',
      ...functional.map(f => `${f.step}: ${f.outcome.decision}${f.outcome.decision === 'Allow' ? '' : ' — onboarding would fail'}`),
    ],
    sample:{tenant_id:sample.TenantId, slug:sample.TenantSlug}});
}

function testS2Azure(){
  const pkg = JSON.parse(read('package.json'));
  const sdks = Object.keys(pkg.dependencies || {}).filter(d => d.startsWith('@azure/'));
  const imports = walk('src', p => /\.(ts|tsx)$/.test(p)).filter(p => /from ["']@azure\//.test(read(p)));
  record({id:'S2', cloud:'azure', claim:'The platform holds no credential able to read a tenant document',
    method:'Static: the application\'s dependencies and imports',
    result:sdks.length === 0 && imports.length === 0 ? 'PASS' : 'FAIL',
    summary:'The application carries no Azure SDK and stores no Azure credential. Reach into a subscription exists only through a deploy-workflow run in the tenant\'s environment (Known Limitation #8); see S9 for how a dispatch can reach it.',
    evidence:[`package.json @azure/* runtime dependencies: ${sdks.length ? sdks.join(', ') : 'none'}`, `src/ files importing @azure/*: ${imports.length ? imports.join(', ') : 'none'}`]});
}

function testS3(){
  const tf = read('infra/terraform/main.tf');
  const actions = JSON.parse(/Action\s*=\s*(\[[^\]]*\])/.exec(block(tf, 'resource "aws_iam_role_policy" "docs_signer_s3"'))[1]);
  const attached = [...tf.matchAll(/resource "(aws_iam_role_policy(?:_attachment)?)" "(\w+)" \{([\s\S]*?)\n\}/g)].filter(m => /role\s*=\s*aws_iam_role\.docs_signer\.(id|name)/.test(m[3]));
  const otherS3 = attached.filter(m => m[2] !== 'docs_signer_s3' && /s3:/.test(m[3])).map(m => m[2]);
  const policy = [{Sid:'docs_signer_s3', Effect:'Allow', Action:actions, Resource:`${docsBucket}/*`}];
  const aws = {
    read:evaluate(policy, {action:'s3:GetObject', resource:`${docsBucket}/contract.pdf`}).decision,
    list:evaluate(policy, {action:'s3:ListBucket', resource:docsBucket}).decision,
    write_control:evaluate(policy, {action:'s3:PutObject', resource:`${docsBucket}/contract.pdf`}).decision,
  };
  const az = read('infra/terraform/azure/main.tf');
  const definition = block(az, 'resource "azurerm_role_definition" "docs_signer"');
  const strings = key => [...(new RegExp(`${key}\\s*=\\s*\\[([\\s\\S]*?)\\]`).exec(definition)?.[1] ?? '').matchAll(/"([^"]+)"/g)].map(m => m[1]);
  const dataActions = strings('data_actions'), controlActions = strings('(?<!data_)actions');
  const assignments = [...az.matchAll(/resource "azurerm_role_assignment" "(\w+)" \{([\s\S]*?)\n\}/g)].filter(m => /azurerm_linux_function_app\.docs_signer\.identity/.test(m[2]));
  const foreignRoles = assignments.filter(m => !/azurerm_role_definition\.docs_signer\./.test(m[2])).map(m => m[1]);
  const vaultAccess = /object_id\s*=\s*azurerm_linux_function_app\.docs_signer/.test(az);
  const azureReads = dataActions.filter(a => /\/read$|\*/.test(a));
  const pass = aws.read !== 'Allow' && aws.list !== 'Allow' && aws.write_control === 'Allow' && otherS3.length === 0 && azureReads.length === 0 && foreignRoles.length === 0 && !vaultAccess;
  record({id:'S3', cloud:'both', claim:'The docs-signer can write and delete documents but never read or list them',
    method:'Static: every policy attached to the signer\'s role (AWS) and every role assigned to the signer\'s identity (Azure)',
    result:pass ? 'PASS' : 'FAIL',
    evidence:[
      `AWS signer S3 actions ${JSON.stringify(actions)} (${at('infra/terraform/main.tf', /Action\s*=\s*\["s3:PutObject", "s3:DeleteObject"\]/)}): GetObject ${aws.read}, ListBucket ${aws.list}, PutObject (control) ${aws.write_control}`,
      `AWS policies attached to the signer role: ${attached.map(m => m[2]).join(', ')}; others granting s3: ${otherS3.length ? otherS3.join(', ') : 'none'}`,
      `Azure signer role ${at('infra/terraform/azure/main.tf', /resource "azurerm_role_definition" "docs_signer"/)}: actions ${JSON.stringify(controlActions)}, data actions ${JSON.stringify(dataActions)}`,
      `Azure role assignments to the signer identity: ${assignments.map(m => m[1]).join(', ')}; using another role: ${foreignRoles.length ? foreignRoles.join(', ') : 'none'}; Key Vault access policy: ${vaultAccess ? 'present' : 'none'}`,
    ]});
}

function testS8Static(){
  const provider = {Federated:sample.GitHubOidcProvider};
  const token = (sub, aud = 'sts.amazonaws.com') => evaluate(deployTrust, {action:'sts:AssumeRoleWithWebIdentity', caller:provider, context:{'token.actions.githubusercontent.com:aud':aud, 'token.actions.githubusercontent.com:sub':sub}}).decision;
  const own = `repo:${owner}/${repo}:environment:tenant-${sample.TenantId}`;
  const cases = [
    ['This tenant\'s environment (control)', own, 'Allow'],
    ['Another tenant\'s environment', `repo:${owner}/${repo}:environment:tenant-00000000-0000-4000-8000-000000000000`, 'refused'],
    ['The deploy branch, without an environment', `repo:${owner}/${repo}:ref:refs/heads/main`, 'refused'],
    ['A fork naming the same environment', `repo:attacker/${repo}:environment:tenant-${sample.TenantId}`, 'refused'],
    ['A prefix of the environment name', `repo:${owner}/${repo}:environment:tenant-${sample.TenantId.slice(0,8)}`, 'refused'],
  ].map(([name, sub, expect]) => ({name, decision:token(sub), expect}));
  cases.push({name:'Right subject, Azure\'s audience', decision:token(own, 'api://AzureADTokenExchange'), expect:'refused'});
  const statement = deployTrust.find(s => s.Sid === 'GitHubActionsDeploy');
  const exact = Object.keys(statement.Condition).every(op => op === 'StringEquals');
  const azure = JSON.parse(read('infra/bootstrap/azure/tenant-bootstrap.json'));
  const expected = "[format('repo:{0}/{1}:environment:tenant-{2}', parameters('gitHubOwner'), parameters('gitHubRepo'), parameters('chatbotId'))]";
  const nested = azure.resources.find(r => r.type === 'Microsoft.Resources/deployments');
  const credential = nested.properties.template.resources.find(r => r.type.endsWith('/federatedIdentityCredentials'));
  const azureOk = azure.variables.federatedSubject === expected && nested.properties.parameters.federatedSubject?.value === "[variables('federatedSubject')]" && credential.properties.subject === "[parameters('federatedSubject')]" && credential.properties.issuer === 'https://token.actions.githubusercontent.com' && JSON.stringify(credential.properties.audiences) === '["api://AzureADTokenExchange"]';
  const pass = cases.every(c => c.expect === 'Allow' ? c.decision === 'Allow' : c.decision !== 'Allow') && exact && azureOk;
  record({id:'S8', cloud:'both', claim:'Only a run in the tenant\'s own GitHub environment can sign in to its cloud',
    method:'Static: AWS trust policy evaluated against forged token claims; Azure federated credential checked against the expected subject expression. The live half (a real token from another environment) is not run.',
    result:pass ? 'PASS (static)' : 'FAIL', cases,
    evidence:[`AWS subject condition operator: ${Object.keys(statement.Condition).join(', ')} (${at(awsTemplateFile, /Sid: GitHubActionsDeploy/)})`, `Azure subject: ${azure.variables.federatedSubject} (${at('infra/bootstrap/azure/tenant-bootstrap.json', /"federatedSubject":/)}); issuer and audience ${azureOk ? 'as expected' : 'NOT as expected'}`]});
}

// ── S7: the database ─────────────────────────────────────────────────────
const encryptedColumns = ['llm_api_key_encrypted','pinecone_api_key_encrypted','docs_signer_secret_encrypted'];
async function testS7(sql){
  const tenants = await sql.query('SELECT * FROM tenants');
  const key = /^[0-9a-f]{64}$/i.test(process.env.PLATFORM_ENCRYPTION_KEY || '') ? Buffer.from(process.env.PLATFORM_ENCRYPTION_KEY,'hex') : null;
  const values = [], malformed = [], unauthenticated = [], decrypted = [];
  for(const t of tenants) for(const column of encryptedColumns){
    const blob = t[column]; if(blob === null) continue;
    values.push(blob);
    const m = /^([0-9a-f]{24}):([0-9a-f]{32}):([0-9a-f]+)$/.exec(blob);
    if(!m){ malformed.push(`${t.slug}.${column}`); continue; }
    if(!key) continue;
    try{
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(m[1],'hex')); decipher.setAuthTag(Buffer.from(m[2],'hex'));
      decrypted.push({kind:`tenant ${t.slug} ${column.replace('_encrypted','')}`, value:Buffer.concat([decipher.update(Buffer.from(m[3],'hex')), decipher.final()]).toString('utf8')});
    }catch{ unauthenticated.push(`${t.slug}.${column}`); }
  }
  const ivs = values.map(v => v.split(':')[0]); const reusedIvs = ivs.length - new Set(ivs).size;
  const notErased = tenants.filter(t => t.deleted_at && [...encryptedColumns,'docs_signer_url'].some(c => t[c] !== null)).map(t => t.slug);
  // Every text column of every table, not only the ones meant to hold secrets.
  const columns = await sql.query(`SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public' AND data_type IN ('text','character varying','jsonb','json') ORDER BY table_name, ordinal_position`);
  const byTable = {}; for(const c of columns) (byTable[c.table_name] ??= []).push(c.column_name);
  const plaintext = []; let scanned = 0;
  for(const [table, cols] of Object.entries(byTable)){
    const rows = await sql.query(`SELECT ${cols.map(c => `"${c}"::text AS "${c}"`).join(', ')} FROM "${table}"`);
    scanned += rows.length * cols.length;
    for(const column of cols){
      if(encryptedColumns.includes(column)) continue;
      for(const [kind, pattern] of Object.entries(keyPatterns)){
        const hits = rows.filter(r => r[column] && pattern.test(r[column])).length;
        if(hits) plaintext.push({table, column, kind, rows:hits});
      }
    }
  }
  const pass = malformed.length === 0 && unauthenticated.length === 0 && reusedIvs === 0 && notErased.length === 0 && plaintext.length === 0;
  record({id:'S7', cloud:'both', claim:'No secret is stored in plaintext; stored secrets are AES-256-GCM ciphertexts',
    method:'Read-only queries: format, authentication under the current key and IV uniqueness of every stored ciphertext; erasure on deleted tenants; a credential-pattern scan of every text column of every table',
    result:pass ? 'PASS' : 'FAIL',
    summary:plaintext.some(p => p.table === 'accounts') ? 'The accounts matches are operators\' GitHub sign-in tokens, which the next-auth Drizzle adapter (src/auth.ts) stores as GitHub returns them. Nothing in the platform reads them after sign-in; it dispatches with GITHUB_PAT.' : undefined,
    evidence:[
      `${values.length} stored ciphertexts across ${tenants.length} tenants; malformed: ${malformed.length}`,
      key ? `authenticate under PLATFORM_ENCRYPTION_KEY: ${values.length - malformed.length - unauthenticated.length}/${values.length - malformed.length}` : 'PLATFORM_ENCRYPTION_KEY unavailable: authentication not checked',
      `reused 96-bit IVs: ${reusedIvs} (GCM loses confidentiality and integrity if an IV repeats under one key)`,
      `deleted tenants still holding secrets: ${notErased.length ? notErased.join(', ') : 'none'}`,
      `credential-pattern matches outside the encrypted columns: ${plaintext.length ? plaintext.map(p => `${p.table}.${p.column} ${p.kind} ×${p.rows}`).join('; ') : 'none'} (${scanned} cells scanned)`,
    ], malformed, unauthenticated, plaintext});
  return decrypted;
}

// ── Docker-run scanners ──────────────────────────────────────────────────
const hostPath = p => path.resolve(p).replace(/\\/g,'/');
function docker(image, mounts, argv, entrypoint){
  const a = ['run','--rm'];
  for(const [host, container, mode] of mounts) a.push('-v', `${hostPath(host)}:${container}${mode ? `:${mode}` : ''}`);
  if(entrypoint) a.push('--entrypoint', entrypoint);
  const run = spawnSync('docker', [...a, image, ...argv], {encoding:'utf8', maxBuffer:1 << 28});
  if(run.error) throw run.error;
  return run;
}
// OpenRouter and Pinecone keys are the credential types this platform handles that
// gitleaks' default rules may not know.
const gitleaksConfig = `[extend]
useDefault = true

[[rules]]
id = "openrouter-api-key"
description = "OpenRouter API key"
regex = '''sk-or-v1-[a-f0-9]{64}'''
keywords = ["sk-or-v1-"]

[[rules]]
id = "pinecone-api-key"
description = "Pinecone API key"
regex = '''pcsk_[A-Za-z0-9_]{20,}'''
keywords = ["pcsk_"]
`;
function gitleaks(mode, target, report){
  fs.writeFileSync(path.join(work,'gitleaks.toml'), gitleaksConfig);
  const command = `git config --global --add safe.directory /repo && gitleaks ${mode} ${target} --config /work/gitleaks.toml --redact --no-banner --log-level warn --report-format json --report-path /out/${report}`;
  const mounts = [['.', '/repo', 'ro'], [work, '/work', 'ro'], [dir, '/out']];
  const run = docker(images.gitleaks, mounts, ['-c', command], 'sh');
  if(run.status > 1) throw new Error(`gitleaks ${mode} failed: ${run.stderr.trim().slice(-500)}`);
  // Keep what triage needs; drop author names and addresses.
  const findings = JSON.parse(read(path.join(dir, report))).map(f => ({RuleID:f.RuleID, Description:f.Description, File:f.File, StartLine:f.StartLine, Commit:f.Commit || undefined, Date:f.Date || undefined, Match:f.Match, Fingerprint:f.Fingerprint}));
  fs.writeFileSync(path.join(dir, report), JSON.stringify(findings, null, 2));
  return findings;
}
async function gh(pathname, raw){
  const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/${pathname}`, {headers:{Authorization:`Bearer ${process.env.GITHUB_PAT}`, Accept:'application/vnd.github+json'}});
  if(raw) return response;
  if(!response.ok) throw new Error(`GitHub HTTP ${response.status} for ${pathname}`);
  return response.json();
}
// Every run's log archive, read in memory and written out under sanitised names
// (no extractAllTo, so archive paths and symlinks never reach the filesystem).
async function downloadLogs(){
  const logs = path.join(work,'logs'); fs.rmSync(logs,{recursive:true,force:true}); fs.mkdirSync(logs,{recursive:true});
  const runs = [];
  for(let page = 1;; page++){ const j = await gh(`actions/runs?per_page=100&page=${page}`); runs.push(...j.workflow_runs); if(j.workflow_runs.length < 100) break; }
  const outcome = {runs:runs.length, with_logs:0, without_logs:{}, files:0, bytes:0, oldest_with_logs:null};
  for(const run of runs){
    const response = await gh(`actions/runs/${run.id}/logs`, true);
    if(!response.ok){ outcome.without_logs[response.status] = (outcome.without_logs[response.status] || 0) + 1; continue; }
    const target = path.join(logs, String(run.id)); fs.mkdirSync(target);
    for(const entry of new AdmZip(Buffer.from(await response.arrayBuffer())).getEntries()){
      if(entry.isDirectory) continue;
      const data = entry.getData(); outcome.files++; outcome.bytes += data.length;
      fs.writeFileSync(path.join(target, entry.entryName.replace(/[^A-Za-z0-9._ -]/g,'_')), data);
    }
    outcome.with_logs++;
    if(!outcome.oldest_with_logs || run.created_at < outcome.oldest_with_logs) outcome.oldest_with_logs = run.created_at;
  }
  return {logs, outcome};
}

async function testS6(knownSecrets){
  const triage = JSON.parse(read(path.join(dir,'gitleaks-triage.json')));
  const history = gitleaks('git', '/repo', 'gitleaks-history.json');
  let logs = null, logFindings = [], logTexts = [];
  if(!has('--skip-logs')){
    logs = await downloadLogs();
    logFindings = gitleaks('dir', '/work/logs', 'gitleaks-logs.json');
    logTexts = walk(logs.logs, () => true).map(f => read(f));
  }
  const unreviewed = [...history, ...logFindings].filter(f => !triage[f.Fingerprint]);
  // Exact search for every secret the operator holds, in every commit and every log.
  // Values are compared in memory and never written anywhere.
  const gitText = spawnSync('git', ['log','-p','--all','--no-color','--text'], {encoding:'utf8', maxBuffer:1 << 30}).stdout;
  const knownHits = knownSecrets.flatMap(({kind, value}) => [
    ...(gitText.includes(value) ? [{kind, where:'git history'}] : []),
    ...(logTexts.some(t => t.includes(value)) ? [{kind, where:'Actions logs'}] : []),
  ]);
  const pass = unreviewed.length === 0 && knownHits.length === 0;
  record({id:'S6', cloud:'both', claim:'No secret is recoverable from the public repository or its CI logs',
    method:'gitleaks (default rules plus OpenRouter and Pinecone) over every commit and every retained Actions log, with reviewed false positives; exact search for every secret the operator holds',
    result:has('--skip-logs') ? (pass ? 'PASS (git only)' : 'FAIL') : pass ? 'PASS' : 'FAIL',
    evidence:[
      `git history: ${history.length} gitleaks findings, ${history.filter(f => triage[f.Fingerprint]).length} reviewed as false positives (gitleaks-triage.json)`,
      logs ? `Actions logs: ${logs.outcome.runs} runs, ${logs.outcome.with_logs} with retained logs (${logs.outcome.files} files, ${(logs.outcome.bytes/1e6).toFixed(1)} MB, oldest ${logs.outcome.oldest_with_logs}), unavailable by HTTP status ${JSON.stringify(logs.outcome.without_logs)}; ${logFindings.length} gitleaks findings` : 'Actions logs: not scanned (--skip-logs)',
      `unreviewed findings: ${unreviewed.length}`,
      `known secrets searched: ${knownSecrets.length} (${[...new Set(knownSecrets.map(s => s.kind.replace(/^tenant \S+ /,'tenant ')))].join(', ')}); exact matches: ${knownHits.length ? knownHits.map(h => `${h.kind} in ${h.where}`).join('; ') : 'none'}`,
      'Logs deleted before this run cannot be scanned; an exposure in them is outside this test.',
    ], unreviewed:unreviewed.map(f => ({rule:f.RuleID, file:f.File, line:f.StartLine, commit:f.Commit, fingerprint:f.Fingerprint})), logs:logs?.outcome});
}

function scanCheckov(){
  const run = docker(images.checkov, [['.', '/repo', 'ro']], ['-d','/repo','--framework','terraform','cloudformation','arm','github_actions','--skip-path','node_modules','--skip-path','.terraform','--skip-path','.next','--skip-path','docs','--skip-path','coverage','--output','json','--quiet','--compact']);
  let reports = JSON.parse(run.stdout); if(!Array.isArray(reports)) reports = [reports];
  fs.writeFileSync(path.join(dir,'checkov.json'), JSON.stringify(reports, null, 2));
  const failed = reports.flatMap(r => (r.results?.failed_checks || []).map(f => ({framework:r.check_type, id:f.check_id, name:f.check_name, file:f.file_path, resource:f.resource, lines:f.file_line_range})));
  return {summary:reports.map(r => ({framework:r.check_type, passed:r.summary.passed, failed:r.summary.failed, parsing_errors:r.summary.parsing_errors})), failed};
}

function scanZizmor(){
  const run = docker(images.zizmor, [['.', '/repo', 'ro']], ['--offline','--format','json','/repo/.github/workflows']);
  const findings = JSON.parse(run.stdout);
  fs.writeFileSync(path.join(dir,'zizmor.json'), JSON.stringify(findings, null, 2));
  const counts = {}; for(const f of findings){ const k = `${f.determinations.severity} | ${f.ident} | confidence ${f.determinations.confidence}`; counts[k] = (counts[k] || 0) + 1; }
  // For each flagged step, which dispatch inputs reach its shell and which secrets that shell holds.
  const injection = {};
  for(const f of findings.filter(f => f.ident === 'template-injection' && f.determinations.confidence === 'High')){
    const location = f.locations[0]; const file = path.basename(location.symbolic.key.Local.verbatim_path); const feature = location.concrete.feature;
    const entry = injection[file] ??= {steps:0, inputs:new Set(), secrets:new Set()};
    entry.steps++;
    for(const m of feature.matchAll(/\$\{\{\s*(?:github\.event\.)?inputs\.([A-Za-z0-9_-]+)/g)) entry.inputs.add(m[1]);
    for(const m of feature.matchAll(/\$\{\{\s*secrets\.([A-Za-z0-9_]+)/g)) entry.secrets.add(m[1]);
  }
  for(const e of Object.values(injection)){ e.inputs = [...e.inputs].sort(); e.secrets = [...e.secrets].sort(); }
  return {total:findings.length, counts, injection};
}

// Stricter than zizmor, which rates a step output low-confidence: an output can
// carry an input (deploy-tenant-azure.yml parses its `config` input into step
// outputs), so both count as dispatcher-controlled when pasted into a script.
function testS9(zizmor){
  const workflows = walk('.github/workflows', p => /\.ya?ml$/.test(p));
  const pasted = workflows.flatMap(file => Object.values(YAML.parse(read(file)).jobs || {}).flatMap(job => (job.steps || []).flatMap(step =>
    [...(step.run || '').matchAll(/\$\{\{\s*([^}]*?)\s*\}\}/g)].map(m => m[1]).filter(e => /\binputs\.|\bsteps\.[\w-]+\.outputs\./.test(e)).map(expr => ({file:path.basename(file), step:step.name, expr})))));
  const perFile = {}; for(const p of pasted) (perFile[p.file] ??= new Set()).add(p.expr);
  const zizmorHigh = Object.entries(zizmor.counts).filter(([k]) => /\| template-injection \| confidence High/.test(k)).reduce((n, [, v]) => n + v, 0);
  const idToken = workflows.filter(p => /id-token:\s*write/.test(read(p))).map(p => path.basename(p));
  const fail = pasted.length > 0 || zizmorHigh > 0;
  record({id:'S9', cloud:'both', claim:'Dispatching a workflow cannot make it run anything but its own steps',
    method:'Every run: script parsed for a dispatch input or step output expanded in place; zizmor\'s template-injection audit as corroboration',
    result:fail ? 'FAIL' : 'PASS',
    summary:fail ? 'Dispatch inputs are expanded into shell scripts before any validation, so a caller able only to dispatch (GITHUB_PAT, or the actions:write GitHub App SECURITY.md recommends) can run code inside a job that holds id-token: write in the tenant\'s environment. That code can mint the tenant\'s cloud token and, on Azure, claim its application secrets. Passing inputs through env: and quoting them in the shell closes this.'
      : 'Every dispatch input and step output reaches a script through env:, so its value is data to the shell and never source code. src/lib/deployPipeline.test.ts holds the same property for every workflow, so a later edit cannot reintroduce it unnoticed.',
    evidence:[
      ...(pasted.length ? Object.entries(perFile).map(([file, exprs]) => `${file}: ${exprs.size} distinct values pasted into scripts: ${[...exprs].join(', ')}`) : [`${workflows.length} workflows: no input or step output expanded inside a run: script`]),
      `zizmor template-injection findings at high confidence: ${zizmorHigh}`,
      `workflows granting id-token: write: ${idToken.join(', ')}`,
    ]});
}

// ── S10: one operator cannot reach another operator's tenants ────────────
// src/app/tenantIsolation.test.ts runs every tenant-scoped action's real SQL
// against a fake database holding two operators' tenants; this maps its
// results onto the five cases. S10.1 is also checked live: without a session,
// the hosted platform must answer 401 or redirect to sign-in.
const s10Cases = [
  ['S10.1', 'Access the deployment API and tenant actions without a session', '401 or redirect'],
  ['S10.2', 'Request another operator\'s deployment with one\'s own session', '403 or 404'],
  ['S10.3', 'Trigger destruction of another operator\'s tenant', 'Rejected'],
  ['S10.4', 'Request a document-upload authorization for another operator\'s tenant', 'Rejected'],
  ['S10.5', 'Put another operator\'s tenant, document or chatbot ID into a request', 'No cross-tenant access'],
];
async function testS10(target){
  const out = path.join(work,'s10-vitest.json');
  spawnSync(process.execPath, ['node_modules/vitest/vitest.mjs','run','src/app/tenantIsolation.test.ts','--reporter=json',`--outputFile=${out}`], {encoding:'utf8', maxBuffer:1 << 26});
  const assertions = fs.existsSync(out) ? JSON.parse(read(out)).testResults.flatMap(r => r.assertionResults) : [];
  const cases = s10Cases.map(([id, action, expected]) => {
    const tests = assertions.filter(a => a.title.startsWith(`${id} `)).map(a => ({title:a.title.slice(id.length + 1), status:a.status, failure:a.failureMessages?.[0]?.split('\n')[0]}));
    return {id, action, expected, tests, result:tests.length && tests.every(t => t.status === 'passed') ? 'PASS' : 'FAIL'};
  });
  // Live S10.1: plain unauthenticated GETs, nothing that could change state.
  const live = [];
  if(target){
    const nobody = crypto.randomUUID();
    for(const [name, pathname] of [['Deployment progress API', `/api/deployments/${nobody}/progress`], ['Dashboard', '/'], ['A tenant page', `/tenants/${nobody}`]]){
      try{
        const r = await fetch(`${target}${pathname}`, {redirect:'manual', signal:AbortSignal.timeout(20000)});
        const location = r.headers.get('location') || '';
        const refused = r.status === 401 || (r.status >= 300 && r.status < 400 && /signin/.test(location));
        live.push({name, path:pathname.replace(nobody,'<random id>'), status:r.status, location:location.replace(/^https?:\/\/[^/]+/, '').split('?')[0], refused});
      }catch(e){ live.push({name, path:pathname.replace(nobody,'<random id>'), status:0, location:e.cause?.code ?? e.name, refused:false}); }
    }
    cases[0].live = live;
    if(live.some(l => !l.refused)) cases[0].result = 'FAIL';
  }
  const failing = cases.filter(c => c.result !== 'PASS');
  record({id:'S10', cloud:'both', claim:'One operator cannot reach another operator\'s tenants through the platform',
    method:`Every tenant-scoped action's real SQL run against a fake database holding two operators' tenants (src/app/tenantIsolation.test.ts), each refusal paired with a control on the operator's own tenant${target ? `; S10.1 also live against ${target}` : ''}`,
    result:assertions.length === 0 ? 'INCONCLUSIVE' : failing.length ? 'FAIL' : 'PASS',
    summary:failing.length ? `${failing.map(c => c.id).join(', ')} failed. ${failing.flatMap(c => c.tests.filter(t => t.status !== 'passed').map(t => `"${t.title}"`)).join('; ')}.` : 'Every action that names a tenant, deployment or document checks that the caller owns it, in the query itself.',
    cases});
}

// ── S5: live, against the platform the runners call ─────────────────────
async function testS5(sql, target){
  const b64 = v => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');
  const call = async (pathname, headers, body) => {
    try{
      const response = await fetch(`${target}${pathname}`, {method:'POST', headers:{'content-type':'application/json', ...headers}, body:JSON.stringify(body), redirect:'manual', signal:AbortSignal.timeout(20000)});
      const text = await response.text(); let error = null; try{ error = JSON.parse(text).error ?? null; }catch{}
      // Vercel's firewall answers some forgeries itself; such a request never reached the platform.
      const edge = response.headers.get('x-vercel-mitigated') === 'deny';
      return {status:response.status, edge, error:edge ? 'refused by the hosting firewall' : typeof error === 'string' ? error.slice(0,140) : error ? 'validation error' : null};
    }catch(e){ return {status:0, edge:false, error:e.cause?.code ?? e.name}; }
  };
  const nobody = crypto.randomUUID(), secret = process.env.DEPLOY_WEBHOOK_SECRET || '';
  const flip = s => s.slice(0,-1) + (s.at(-1) === 'a' ? 'b' : 'a');
  const status = `/api/deployments/${nobody}/status`;
  const webhook = [
    ['No secret header', {}, 401],
    ['Random secret of the same length', {'x-webhook-secret':crypto.randomBytes(secret.length).toString('hex').slice(0, secret.length)}, 401],
    ['Real secret with its last character changed', {'x-webhook-secret':flip(secret)}, 401],
    ['Real secret with one character appended', {'x-webhook-secret':secret + 'x'}, 401],
    ['Real secret missing its last character', {'x-webhook-secret':secret.slice(0,-1)}, 401],
    ['Control: real secret, unknown deployment', {'x-webhook-secret':secret}, 404],
  ];
  const cases = [];
  for(const [name, headers, expect] of webhook) cases.push({endpoint:'status', name, expect, ...(await call(status, headers, {status:'running'}))});
  const secretAccepted = cases.at(-1).status === 404;
  // Replay: the real secret against a deployment that has already finished. Picked
  // from a deleted tenant and from before the OIDC study's cutoff, so even a failure
  // of the guard would touch no data that any other evaluation uses.
  const [finished] = await sql.query(`SELECT d.id, d.status, d.finished_at, d.error_message FROM deployments d JOIN tenants t ON t.id = d.tenant_id WHERE t.deleted_at IS NOT NULL AND d.kind = 'deploy' AND d.status IN ('succeeded','failed','cancelled') AND d.started_at < '2026-09-28T01:02:44Z' ORDER BY d.started_at LIMIT 1`);
  if(finished && secretAccepted){
    const replay = await call(`/api/deployments/${finished.id}/status`, {'x-webhook-secret':secret}, {status:finished.status});
    const [after] = await sql.query('SELECT status, finished_at, error_message FROM deployments WHERE id = $1', [finished.id]);
    const unchanged = after.status === finished.status && String(after.finished_at) === String(finished.finished_at) && after.error_message === finished.error_message;
    cases.push({endpoint:'status', name:`Replay of a terminal callback to a finished deployment (row unchanged: ${unchanged})`, expect:409, ...replay, status:unchanged ? replay.status : `${replay.status}, ROW CHANGED`});
  }
  // The secrets endpoint releases LLM, Pinecone and docs-signer keys to Azure runs.
  // Each forged token carries the claims a real run's would, so only the signature
  // check can refuse it.
  const jwks = await (await fetch('https://token.actions.githubusercontent.com/.well-known/jwks')).json();
  const githubKey = jwks.keys[0];
  const now = Math.floor(Date.now()/1000);
  const claims = {iss:'https://token.actions.githubusercontent.com', aud:'ai-chatbot-platform:tenant-secrets', repository:`${owner}/${repo}`, sub:`repo:${owner}/${repo}:environment:tenant-${nobody}`, workflow_ref:`${owner}/${repo}/.github/workflows/deploy-tenant-azure.yml@refs/heads/main`, run_id:'1', run_attempt:'1', iat:now, nbf:now - 5, exp:now + 300};
  const unsigned = header => `${b64(header)}.${b64(claims)}`;
  const {privateKey} = crypto.generateKeyPairSync('rsa', {modulusLength:2048});
  const rs256 = `${unsigned({alg:'RS256', typ:'JWT', kid:githubKey.kid})}.${crypto.sign('RSA-SHA256', Buffer.from(unsigned({alg:'RS256', typ:'JWT', kid:githubKey.kid})), privateKey).toString('base64url')}`;
  const pem = crypto.createPublicKey({key:githubKey, format:'jwk'}).export({type:'spki', format:'pem'});
  const hs256 = `${unsigned({alg:'HS256', typ:'JWT', kid:githubKey.kid})}.${crypto.createHmac('sha256', pem).update(unsigned({alg:'HS256', typ:'JWT', kid:githubKey.kid})).digest('base64url')}`;
  const tokens = [
    ['No bearer token', null],
    ['A string that is not a JWT', 'not-a-jwt'],
    ['Unsigned token (alg: none) with valid-looking claims', `${unsigned({alg:'none', typ:'JWT'})}.`],
    ['Token signed by a foreign RSA key under GitHub\'s key ID', rs256],
    ['Algorithm confusion: HS256 keyed with GitHub\'s public key', hs256],
  ];
  for(const [name, token] of tokens) cases.push({endpoint:'secrets', name, expect:401, ...(await call(`/api/deployments/${nobody}/secrets`, token ? {authorization:`Bearer ${token}`} : {}, {}))});
  const reachable = cases.every(c => c.status !== 0);
  const pass = cases.every(c => c.status === c.expect || (c.expect === 401 && c.edge));
  const atEdge = cases.filter(c => c.edge).length;
  record({id:'S5', cloud:'both', claim:'The deployment webhooks cannot be forged or replayed',
    method:`Live requests to ${target}: near-miss webhook secrets, a replay against a finished deployment, and forged GitHub OIDC tokens; unit tests in src/app/api/deployments/[id]/status/route.test.ts and src/lib/deploymentSecrets.test.ts cover the same paths in-process`,
    result:!reachable ? 'INCONCLUSIVE' : !secretAccepted ? 'INCONCLUSIVE' : pass ? 'PASS' : 'FAIL',
    summary:!secretAccepted ? 'The control request with the local DEPLOY_WEBHOOK_SECRET was not accepted, so the target holds a different secret and the near-miss cases prove nothing.'
      : atEdge ? `${atEdge} forged request(s) were refused by Vercel's firewall before reaching the platform, so they show the deployment is protected but do not exercise the platform's own check; src/lib/deploymentSecrets.test.ts covers those forgeries against the verifier directly.` : undefined,
    cases});
}

async function main(){
  // Without a database (a clean reproduction holds no credentials) S7 is not
  // run; every other test needs only the repository.
  const sql = process.env.DATABASE_URL ? neon(process.env.DATABASE_URL) : null;
  testS2Aws(); testS2Azure(); testS3(); testS8Static();
  const tenantSecrets = sql ? await testS7(sql) : (record({id:'S7', cloud:'both', claim:'No secret is stored in plaintext; stored secrets are AES-256-GCM ciphertexts', method:'Direct inspection of the tenants table', result:'NOT RUN', evidence:['No DATABASE_URL']}), []);
  const knownSecrets = [...['DEPLOY_WEBHOOK_SECRET','GITHUB_PAT','AUTH_SECRET','AUTH_GITHUB_SECRET','PLATFORM_ENCRYPTION_KEY'].filter(n => (process.env[n] || '').length >= 12).map(n => ({kind:n, value:process.env[n]})), ...tenantSecrets.filter(s => s.value.length >= 12)];
  try{ const p = decodeURIComponent(new URL(process.env.DATABASE_URL).password); if(p.length >= 12) knownSecrets.push({kind:'DATABASE_URL password', value:p}); }catch{}
  let checkov = null, zizmor = null;
  if(has('--skip-docker')){
    record({id:'S6', cloud:'both', claim:'No secret is recoverable from the public repository or its CI logs', method:'gitleaks', result:'NOT RUN', evidence:['--skip-docker']});
  }else{
    await testS6(knownSecrets);
    checkov = scanCheckov(); zizmor = scanZizmor(); testS9(zizmor);
  }
  const target = option('--target');
  await testS10(target?.replace(/\/$/,''));
  if(target) await testS5(sql, target.replace(/\/$/,''));
  else record({id:'S5', cloud:'both', claim:'The deployment webhooks cannot be forged or replayed', method:'Live requests', result:'NOT RUN', evidence:['No --target given']});
  // S1 and S4 need live tenants; scripts/evaluate-live.cjs runs them and leaves
  // its results in docs/evaluation/live/, which are folded in here when present.
  const live = name => { try { return JSON.parse(read(`docs/evaluation/live/${name}`)); } catch { return null; } };
  const s1 = live('isolation.json');
  record(s1 ? {id:'S1', cloud:s1.same_cloud ? s1.tenants[0].cloud : 'both', claim:'One tenant\'s chatbot cannot retrieve another tenant\'s documents', method:`Canary documents in two live tenants (${s1.tenants.map(t => `${t.slug}: ${t.cloud} ${t.vector_store}`).join(', ')}), each asked for its own canary (control) and the other's (probe); scripts/evaluate-live.cjs isolation`, result:s1.result, summary:s1.summary,
      evidence:[...s1.probes.map(p => `${p.tenant} ${p.kind}: ${p.result} (own code in answer: ${p.own_code_in_answer}, peer code in answer: ${p.peer_code_in_answer}, peer sources: ${p.peer_sources.length})`), `Extracted ${s1.extracted_at}; answers in docs/evaluation/live/isolation.json`]}
    : {id:'S1', cloud:'both', claim:'One tenant\'s chatbot cannot retrieve another tenant\'s documents', method:'Canary documents in two live tenants', result:'NOT RUN', evidence:['Needs two tenants deployed at once; run scripts/evaluate-live.cjs isolation.']});
  const s4 = fs.existsSync('docs/evaluation/live') ? fs.readdirSync('docs/evaluation/live').filter(f => f.startsWith('cloudtrail-')).map(live) : [];
  if(s4.length) for(const r of s4) record({id:'S4', cloud:'aws', claim:'Platform activity in a customer account stays within the documented inventory', method:`CloudTrail event history of ${r.tenant}, onboarding to last deploy (${r.window.from} to ${r.window.to}); scripts/evaluate-live.cjs cloudtrail`, result:r.result, summary:r.summary,
      evidence:[`Allowed: ${r.allowed_inventory.join('; ')}`, `${r.events_in_window} events in the window; ${r.platform_events.length} by the platform; ${r.violations.length} outside the inventory`, ...r.violations.map(v => `outside the inventory: ${v.source}:${v.name} by ${v.actor}`), 'Event history holds management events only; S3 object reads are data events and are covered statically by S2.']});
  else record({id:'S4', cloud:'aws', claim:'Platform activity in a customer account stays within the documented inventory', method:'CloudTrail events of one full deploy', result:'NOT RUN', evidence:['Needs a live AWS deploy; run scripts/evaluate-live.cjs cloudtrail.']});

  const head = spawnSync('git', ['rev-parse','HEAD'], {encoding:'utf8'}).stdout.trim();
  const dirty = spawnSync('git', ['status','--porcelain','--untracked-files=no'], {encoding:'utf8'}).stdout.trim().length > 0;
  const output = {extracted_at:new Date().toISOString(), commit:head, uncommitted_changes:dirty, images, target:target ?? null, results, checkov, zizmor};
  fs.writeFileSync(path.join(dir,'results.json'), JSON.stringify(output, null, 2));
  fs.writeFileSync(path.join(dir,'REPORT.md'), report(output));
  console.log(`\nWrote ${dir}/REPORT.md and results.json`);
}

function report(o){
  const order = ['S1','S2','S3','S4','S5','S6','S7','S8','S9','S10'];
  const rows = [...o.results].sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id) || a.cloud.localeCompare(b.cloud));
  const cell = s => String(s).replace(/\|/g,'\\|').replace(/\n/g,' ');
  const lines = [
    '# Security evaluation', '',
    `Generated ${o.extracted_at} by \`node scripts/evaluate-security.cjs${o.target ? ` --target ${o.target}` : ''}\` at commit \`${o.commit.slice(0,12)}\`${o.uncommitted_changes ? ' with uncommitted changes' : ''}. Every test is read-only; see the script header for what the live tests send.`, '',
    'Each test turns one claim from `SECURITY.md` or `ARCHITECTURE.md` into a pass/fail criterion (`EVALUATION.md` §5). S8 to S10 extend the original seven. A static result is evidence about the code and templates as written, not about every deployed tenant.', '',
    '| ID | Cloud | Claim | Result | Method |', '|---|---|---|---|---|',
    ...rows.map(r => `| ${r.id} | ${r.cloud} | ${cell(r.claim)} | **${r.result}** | ${cell(r.method)} |`), '',
  ];
  for(const r of rows){
    if(r.result === 'NOT RUN' && !r.links) { lines.push(`## ${r.id} (${r.cloud}): not run`, '', ...(r.evidence || []).map(e => `- ${e}`), ''); continue; }
    lines.push(`## ${r.id} (${r.cloud}): ${r.result}`, '', `**Claim.** ${r.claim}.`, '');
    if(r.summary) lines.push(r.summary, '');
    const chainTable = links => ['| Step | Decision | Statements | Evidence |', '|---|---|---|---|', ...links.map(l => `| ${cell(l.step)} | ${l.outcome.decision} | ${l.outcome.statements.join(', ')} | ${cell(mask(l.evidence))} |`), ''];
    for(const p of r.paths ?? []) lines.push(`**Path through \`${p.role}\`: ${p.complete ? 'reaches the documents' : 'broken'}.**`, '', ...chainTable(p.links));
    if(r.links) lines.push(...chainTable(r.links));
    if(r.controls){
      lines.push('Negative controls, each expected to be refused (so a PASS or FAIL is not an artefact of the evaluator):', '', '| Control | Decision |', '|---|---|', ...r.controls.map(c => `| ${cell(c.step)} | ${c.outcome.decision} |`), '');
      if(r.holders?.length) lines.push('Who can act as the platform role, from its deployed trust policy:', '', ...r.holders.map(h => `- ${h}`), '');
    }
    if(r.cases && r.id === 'S8') lines.push('| Token subject | Decision | Expected |', '|---|---|---|', ...r.cases.map(c => `| ${cell(c.name)} | ${c.decision} | ${c.expect} |`), '');
    if(r.cases && r.id === 'S10'){
      lines.push('| Case | Action | Expected | Tests | Result |', '|---|---|---|---|---|', ...r.cases.map(c => `| ${c.id} | ${cell(c.action)} | ${c.expected} | ${c.tests.filter(t => t.status === 'passed').length}/${c.tests.length} passed | **${c.result}** |`), '');
      for(const c of r.cases) for(const t of c.tests.filter(t => t.status !== 'passed')) lines.push(`- ${c.id} failed: ${t.title} — ${cell(t.failure ?? t.status)}`);
      const live = r.cases.find(c => c.live)?.live;
      if(live) lines.push('', 'S10.1 live, without a session:', '', '| Request | Path | HTTP | Redirects to | Refused |', '|---|---|---|---|---|', ...live.map(l => `| ${l.name} | \`${l.path}\` | ${l.status} | ${cell(l.location || '—')} | ${l.refused ? 'yes' : '**no**'} |`));
      lines.push('');
    }
    if(r.cases && r.id === 'S5') lines.push('| Endpoint | Request | HTTP | Expected | Answered by | Response |', '|---|---|---|---|---|---|', ...r.cases.map(c => `| ${c.endpoint} | ${cell(c.name)} | ${c.status} | ${c.expect} | ${c.edge ? 'Vercel firewall' : 'platform'} | ${cell(c.error ?? '')} |`), '');
    if(r.evidence) lines.push(...r.evidence.map(e => `- ${mask(e)}`), '');
    if(r.unreviewed?.length) lines.push('Unreviewed findings:', '', ...r.unreviewed.map(u => `- ${u.rule} in ${u.file}:${u.line}${u.commit ? ` (${u.commit.slice(0,8)})` : ''}`), '');
  }
  if(o.checkov){
    lines.push('## Infrastructure scan (Checkov)', '', `\`${o.images.checkov}\` over the Terraform roots, both bootstrap templates and the workflows. Checkov's open-source rules carry no severity; each failed check needs a disposition (fixed, accepted with reason, or documented limitation). Raw output: \`checkov.json\`.`, '',
      '| Framework | Passed | Failed | Parsing errors |', '|---|---:|---:|---:|', ...o.checkov.summary.map(s => `| ${s.framework} | ${s.passed} | ${s.failed} | ${s.parsing_errors} |`), '');
    const byFile = {}; for(const f of o.checkov.failed) (byFile[f.file] ??= []).push(f);
    for(const [file, list] of Object.entries(byFile)) lines.push(`<details><summary>${file}: ${list.length} failed</summary>`, '', ...list.map(f => `- \`${f.id}\` ${f.name} (${f.resource}, lines ${f.lines.join('–')})`), '', '</details>', '');
  }
  if(o.zizmor){
    lines.push('## Workflow scan (zizmor)', '', `\`${o.images.zizmor}\`, offline audits. Raw output: \`zizmor.json\`.`, '', '| Severity | Audit | Confidence | Findings |', '|---|---|---|---:|',
      ...Object.entries(o.zizmor.counts).sort().map(([k, n]) => `| ${k.split(' | ').join(' | ').replace('confidence ','')} | ${n} |`), '');
  }
  return lines.join('\n') + '\n';
}

main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
