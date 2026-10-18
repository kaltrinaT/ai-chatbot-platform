/* eslint-disable @typescript-eslint/no-require-imports -- Standalone CommonJS figure script. */
// Figure 4.3 — Identity and trust model.
//
//   node scripts/thesis-figures/fig-4-3-identity-trust.cjs
//
// Who may become whom, and on what condition. Trust policies as written in
// infra/platform/control-plane/main.tf (platform role), infra/bootstrap/aws/
// tenant-bootstrap.yaml (onboarding and deployment roles), infra/bootstrap/
// azure/tenant-bootstrap.json (managed identity and federated credential) and
// infra/terraform/{main.tf,azure/main.tf} (runtime identities). A deployed
// account can lag these; the security evaluation's S2 test reads both.
const {C, figure, render} = require('./lib.cjs');

const f = figure();

// ── platform and GitHub ─────────────────────────────────────────────────
f.group(16, 16, 336, 212, 'PLATFORM', {fill:C.cpTint, stroke:C.cp});
const app = f.node(98, 46, 172, 'Platform app', ['Next.js on Vercel', 'holds no cloud key'], {h:64});
const role = f.node(28, 150, 312, 'Platform role', ['in the platform’s AWS account;', 'may assume onboarding roles only'], {h:64});
f.arrow([[app.cx, app.b], [app.cx, role.y]]);
f.label(app.cx + 8, 130, 'Vercel OIDC, production only');

f.group(368, 16, 336, 212, 'GITHUB', {fill:C.ghTint, stroke:C.gh, nameFill:C.sec});
const run = f.node(380, 46, 312, 'Workflow run', ['environment tenant-{id}; its OIDC token’s', 'subject: repo:{owner}/{repo}:', 'environment:tenant-{id}'], {h:79});
f.arrow([[app.r, 78], [run.x, 78]], 'reply');
f.label((app.r + run.x) / 2, 71, 'dispatch', {anchor:'middle'});
f.label((app.r + run.x) / 2, 94, 'GITHUB_PAT', {anchor:'middle', fill:C.mut});

// ── customer clouds ─────────────────────────────────────────────────────
const CY = 290;
f.group(16, 270, 336, 222, 'CUSTOMER AWS ACCOUNT', {fill:C.custTint, stroke:C.cust, nameFill:C.aws, nameAt:'bottom'});
const onboard = f.node(28, CY, 150, 'Onboarding role', ['writes secrets only;', 'reads nothing'], {h:64, stroke:C.cust});
const deploy = f.node(190, CY, 150, 'Deploy role', ['builds the chatbot;', 'trusts GitHub only'], {h:64, stroke:C.cust});
const awsRun = f.node(28, 382, 312, 'Runtime roles', ['ECS task reads documents; the signer', 'writes and deletes; boundary-capped'], {h:64, stroke:C.cust});
f.arrow([[265, deploy.b], [265, awsRun.y]]);

f.group(368, 270, 336, 222, 'CUSTOMER AZURE SUBSCRIPTION', {fill:C.custTint, stroke:C.cust, nameFill:C.az, nameAt:'bottom'});
const mi = f.node(380, CY, 312, 'Managed identity', ['chatbot-deploy-{slug}: Contributor and', 'User Access Administrator on its own', 'resource group only'], {h:79, stroke:C.cust});
const azRun = f.node(380, 397, 312, 'Runtime identities', ['chatbot reads documents; the', 'signer writes and deletes them'], {h:64, stroke:C.cust});
f.arrow([[mi.cx, mi.b], [mi.cx, azRun.y]]);

// ── trust edges ─────────────────────────────────────────────────────────
f.arrow([[100, role.b], [100, onboard.y]]);
f.label(108, 244, 'AssumeRole +');
f.label(108, 258, 'ExternalId = tenant id');

f.arrow([[275, role.b], [275, deploy.y]], 'refused');
f.badge(275, 246, '✕', {fill:C.warn});
f.label(287, 234, 'not trusted', {fill:C.warn});

f.arrow([[420, run.b], [420, 244], [318, 244], [318, deploy.y]]);
f.label(428, 160, 'OIDC: subject');
f.label(428, 174, 'must equal');
f.label(428, 188, 'tenant-{id}');

f.arrow([[640, run.b], [640, mi.y]]);
f.label(632, 246, 'federated credential,', {anchor:'end'});
f.label(632, 260, 'the same subject', {anchor:'end'});

f.legend(522, [['flow', 'assumes or federates into'], ['reply', 'authenticated request'], ['refused', 'refused']]);

const H = 540;
render('fig-4-3-identity-trust', f.svg(H, 'Identity and trust model. The platform app obtains its platform role through Vercel OIDC and may assume each customer’s write-only onboarding role, bound by ExternalId to the tenant id; the customer’s deploy role does not trust it. Deployments run as a GitHub Actions job whose OIDC subject names one tenant’s environment, which the AWS deploy role and the Azure managed identity’s federated credential each require exactly. The deploy identities create the runtime identities that read and write documents.'), H);
