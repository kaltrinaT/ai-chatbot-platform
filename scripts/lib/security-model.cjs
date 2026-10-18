/* eslint-disable @typescript-eslint/no-require-imports -- Shared by CommonJS evaluation scripts and vitest. */
// The policy model behind the security evaluations: a minimal IAM evaluator,
// the AWS bootstrap template rendered for a sample tenant, the docs-signer's
// permissions on both clouds, and the Azure federated credential.
//
// Used by scripts/evaluate-security.cjs (S2, S3, S8) and by the local
// end-to-end scenarios under src/security-e2e (SEC-E2E-02, SEC-E2E-03), so the
// two cannot evaluate different models of the same policy.
const fs = require('node:fs');
const YAML = require('yaml');

const read = file => fs.readFileSync(file, 'utf8');
function block(source, header){ const m = new RegExp(`${header.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')} \\{([\\s\\S]*?)\\n\\}`).exec(source); if(!m) throw new Error(`No block ${header}`); return m[1]; }

// ── A minimal IAM evaluator ──────────────────────────────────────────────
// Models exactly what the policies under test use: Action, Resource, Principal and
// the StringEquals / StringLike / Null / Bool operators. Anything outside that throws
// instead of being skipped, so a later policy change cannot pass a test by stepping
// outside the model. Every positive result is paired with negative controls.
const asList = v => v === undefined ? [] : Array.isArray(v) ? v : [v];
const wildcard = (pattern, caseless) => new RegExp('^' + String(pattern).split('*').map(part => part.split('?').map(s => s.replace(/[.+^${}()|[\]\\]/g,'\\$&')).join('.')).join('.*') + '$', caseless ? 'i' : '');
const anyMatch = (patterns, value, caseless) => asList(patterns).some(p => wildcard(p, caseless).test(value));
function principalMatches(principal, caller){
  if(!principal) return true;
  return Object.entries(caller).some(([type, arn]) => asList(principal[type]).some(p => {
    const account = /^arn:aws:iam::(\d{12}):root$/.exec(p);
    return account ? arn.split(':')[4] === account[1] : p === '*' || p === arn;
  }));
}
function conditionsHold(condition, context){
  for(const [operator, entries] of Object.entries(condition || {})) for(const [key, expected] of Object.entries(entries)){
    const actual = context[key], wanted = asList(expected).map(String);
    if(operator === 'StringEquals' || operator === 'Bool'){ if(actual === undefined || !wanted.includes(String(actual))) return false; }
    else if(operator === 'StringLike'){ if(actual === undefined || !wanted.some(w => wildcard(w).test(String(actual)))) return false; }
    else if(operator === 'Null'){ if(wanted.includes('true') !== (actual === undefined)) return false; }
    else throw new Error(`IAM condition operator ${operator} is outside the evaluator's model`);
  }
  return true;
}
/**
 * @param {any[]} statements
 * @param {{action: string, resource?: string, caller?: Record<string, string>, context?: Record<string, string>}} request
 * @returns {{decision: 'Allow' | 'ExplicitDeny' | 'ImplicitDeny', statements: string[]}}
 */
function evaluate(statements, {action, resource, caller, context = {}}){
  for(const s of statements) for(const k of ['NotAction','NotResource','NotPrincipal']) if(s[k]) throw new Error(`${k} in ${s.Sid} is outside the evaluator's model`);
  const applies = s => anyMatch(s.Action, action, true) && (s.Resource === undefined || anyMatch(s.Resource, resource)) && (!caller || principalMatches(s.Principal, caller)) && conditionsHold(s.Condition, context);
  const deny = statements.filter(s => s.Effect === 'Deny' && applies(s));
  if(deny.length) return {decision:'ExplicitDeny', statements:deny.map(s => s.Sid)};
  const allow = statements.filter(s => s.Effect === 'Allow' && applies(s));
  return allow.length ? {decision:'Allow', statements:allow.map(s => s.Sid)} : {decision:'ImplicitDeny', statements:[]};
}

// ── The AWS bootstrap template, rendered for one sample tenant ───────────
// Same tag handling as src/lib/bootstrapLinks.test.ts.
const cfnTags = ['Ref','Sub','GetAtt','Equals','If'].flatMap(name => [
  {tag:`!${name}`, resolve: value => ({[name]: value})},
  {tag:`!${name}`, collection:'seq', resolve: seq => ({[name]: seq.toJSON()})},
]);
function render(node, values){
  if(Array.isArray(node)) return node.map(n => render(n, values));
  if(node && typeof node === 'object'){
    const keys = Object.keys(node);
    if(keys.length === 1 && keys[0] === 'Ref') return values[node.Ref] ?? `<${node.Ref}>`;
    if(keys.length === 1 && keys[0] === 'Sub') return String(node.Sub).replace(/\$\{([^}]+)\}/g, (_, name) => values[name] ?? `<${name}>`);
    if(keys.length === 1 && keys[0] === 'If') return render(values[`Condition.${node.If[0]}`] ? node.If[1] : node.If[2], values);
    if(keys.length === 1 && keys[0] === 'GetAtt') return `<${asList(node.GetAtt).join('.')}>`;
    return Object.fromEntries(keys.map(k => [k, render(node[k], values)]));
  }
  return node;
}

const awsTemplateFile = 'infra/bootstrap/aws/tenant-bootstrap.yaml';

/**
 * The values a customer's stack would be created with, for one tenant.
 * @param {{tenantId: string, slug: string, owner?: string, repo?: string, customerAccount?: string, platformAccount?: string, region?: string}} tenant
 * @returns {Record<string, any>}
 */
function sampleTenant({tenantId, slug, owner, repo, customerAccount = '111111111111', platformAccount = '222222222222', region = 'eu-central-1'}){
  const sample = {TenantId:tenantId, TenantSlug:slug, GitHubOwner:owner, GitHubRepo:repo, PlatformAccountId:platformAccount, 'AWS::AccountId':customerAccount, 'AWS::Partition':'aws', 'AWS::Region':region, 'Condition.RegisterProvider':true};
  sample.GitHubOidcProvider = `arn:aws:iam::${customerAccount}:oidc-provider/token.actions.githubusercontent.com`;
  sample.RuntimeRoleBoundary = `arn:aws:iam::${customerAccount}:policy/chatbot-${slug}-runtime-boundary`;
  return sample;
}

/**
 * The template's resources as CloudFormation would create them for `sample`.
 * @param {Record<string, any>} sample
 * @returns {Record<string, any>}
 */
function renderAwsBootstrap(sample){
  return render(YAML.parse(read(awsTemplateFile), {customTags:cfnTags}).Resources, sample);
}

/**
 * Trust and permission statements of one role in a rendered template.
 * @param {Record<string, any>} template
 * @param {string} logicalId
 * @returns {{name: string, arn: string, trust: any[], policy: any[]}}
 */
function roleStatements(template, logicalId){
  const props = template[logicalId].Properties;
  return {
    name:props.RoleName,
    arn:`arn:aws:iam::<account>:role/${props.RoleName}`,
    trust:props.AssumeRolePolicyDocument.Statement,
    policy:(props.Policies || []).flatMap(p => p.PolicyDocument.Statement),
  };
}

/** The platform application's own AWS role policy, as written in its Terraform. */
const controlPlaneFile = 'infra/platform/control-plane/main.tf';
function controlPlaneSource(){
  const permissions = block(read(controlPlaneFile), 'data "aws_iam_policy_document" "permissions"');
  const list = key => JSON.parse(new RegExp(`${key}\\s*=\\s*(\\[[^\\]]*\\])`).exec(permissions)[1]);
  return {source:controlPlaneFile, permissions:[{Sid:/sid\s*=\s*"([^"]+)"/.exec(permissions)[1], Effect:'Allow', Action:list('actions'), Resource:list('resources')}]};
}

/** The AWS docs-signer's S3 statement, from the tenant Terraform. */
function awsDocsSignerPolicy(docsBucketArn){
  const tf = read('infra/terraform/main.tf');
  const actions = JSON.parse(/Action\s*=\s*(\[[^\]]*\])/.exec(block(tf, 'resource "aws_iam_role_policy" "docs_signer_s3"'))[1]);
  return [{Sid:'docs_signer_s3', Effect:'Allow', Action:actions, Resource:`${docsBucketArn}/*`}];
}

/** The Azure docs-signer's custom role, from the tenant Terraform. */
function azureDocsSignerRole(){
  const az = read('infra/terraform/azure/main.tf');
  const definition = block(az, 'resource "azurerm_role_definition" "docs_signer"');
  const strings = key => [...(new RegExp(`${key}\\s*=\\s*\\[([\\s\\S]*?)\\]`).exec(definition)?.[1] ?? '').matchAll(/"([^"]+)"/g)].map(m => m[1]);
  return {actions:strings('(?<!data_)actions'), dataActions:strings('data_actions')};
}

/**
 * Whether an Azure RBAC action list grants `action`. Azure matches actions
 * case-insensitively and allows `*` anywhere in a pattern.
 */
/** @param {string[]} actions @param {string} action @returns {boolean} */
function azureAllows(actions, action){ return anyMatch(actions, action, true); }

/**
 * The federated identity credential the Azure bootstrap template creates,
 * with its subject expression rendered the way ARM's format() would.
 */
function azureFederatedCredential({owner, repo, tenantId}){
  const file = 'infra/bootstrap/azure/tenant-bootstrap.json';
  const azure = JSON.parse(read(file));
  const nested = azure.resources.find(r => r.type === 'Microsoft.Resources/deployments');
  const credential = nested.properties.template.resources.find(r => r.type.endsWith('/federatedIdentityCredentials'));
  const params = {gitHubOwner:owner, gitHubRepo:repo, chatbotId:tenantId};
  const m = /^\[format\('([^']*)',\s*(.*)\)\]$/.exec(azure.variables.federatedSubject);
  if(!m) throw new Error(`federatedSubject is not a format() expression: ${azure.variables.federatedSubject}`);
  const args = [...m[2].matchAll(/parameters\('(\w+)'\)/g)].map(a => { if(!(a[1] in params)) throw new Error(`Unknown parameter ${a[1]}`); return params[a[1]]; });
  const subject = m[1].replace(/\{(\d+)\}/g, (_, i) => args[Number(i)]);
  return {file, subject, issuer:credential.properties.issuer, audiences:credential.properties.audiences,
    wiredThrough:nested.properties.parameters.federatedSubject?.value === "[variables('federatedSubject')]" && credential.properties.subject === "[parameters('federatedSubject')]"};
}

/**
 * How Entra ID matches a presented GitHub token against a federated
 * credential: issuer, subject and audience, each compared exactly.
 * @param {{issuer: string, subject: string, audiences: string[]}} credential
 * @param {{iss: string, sub: string, aud: string}} token
 * @returns {boolean}
 */
function entraAccepts(credential, token){
  return token.iss === credential.issuer && token.sub === credential.subject && credential.audiences.includes(token.aud);
}

// ── Credential patterns ──────────────────────────────────────────────────
const keyPatterns = {
  openai:/\bsk-(?!or-|ant-)(?:proj-)?[A-Za-z0-9_-]{20,}/, anthropic:/\bsk-ant-[A-Za-z0-9_-]{20,}/, openrouter:/\bsk-or-v1-[a-f0-9]{64}\b/,
  pinecone:/\bpcsk_[A-Za-z0-9_]{20,}/, github_token:/\bgh[opusr]_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{50,}/,
  aws_access_key:/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/, private_key:/-----BEGIN [A-Z ]*PRIVATE KEY-----/, jwt:/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
};

module.exports = {
  read, block, asList, evaluate, render, cfnTags,
  awsTemplateFile, sampleTenant, renderAwsBootstrap, roleStatements, controlPlaneFile, controlPlaneSource, awsDocsSignerPolicy,
  azureDocsSignerRole, azureAllows, azureFederatedCredential, entraAccepts, keyPatterns,
};
