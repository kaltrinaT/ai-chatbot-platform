/* eslint-disable @typescript-eslint/no-require-imports -- Standalone CommonJS figure script. */
// Figure 4.2 — Deployment workflow, as swimlanes.
//
//   node scripts/thesis-figures/fig-4-2-deployment-workflow.cjs
//
// One lane per party: the control plane, the GitHub Actions run, and the
// customer's cloud. Steps follow src/app/tenants/new/actions.ts and
// src/lib/aws.ts (onboarding), src/lib/deploy.ts (dispatch), the deploy
// workflows, src/app/api/deployments/[id]/{status,secrets} and
// src/lib/reconcile.ts; the bootstrap is infra/bootstrap/{aws,azure}.
const {C, figure, render} = require('./lib.cjs');

const f = figure();
const LANE = {cp:16, gh:248, cu:480, w:224};
const NX = {cp:LANE.cp + 12, gh:LANE.gh + 12, cu:LANE.cu + 12};
const NW = 200;
const mid = n => n.y + n.h / 2;

// ── stages ──────────────────────────────────────────────────────────────
const boot = f.node(NX.cu, 60, NW, 'Customer bootstrap', ['one-time CloudFormation or', 'ARM template: deploy identity,', 'state storage, onboarding', 'role (AWS)'], {stroke:C.cust});

const onboard = f.node(NX.cp, 170, NW, 'Onboarding', ['inputs validated; keys stored', 'encrypted (AES-256-GCM)']);
const sm = f.node(NX.cu, 170, NW, 'Secrets Manager', [['AWS only', {fill:C.aws}], 'keys written before any run'], {stroke:C.cust});

const dispatch = f.node(NX.cp, 262, NW, 'Dispatch', ['workflow_dispatch with', 'non-secret inputs only']);

const oidc = f.node(NX.gh, 352, NW, 'OIDC authentication', ['the job’s token names', 'environment tenant-{id}']);
const release = f.node(NX.cp, 352, NW, 'Secrets release', [['Azure only', {fill:C.az}], 'keys released once, to', 'that run’s verified token']);
const identity = f.node(NX.cu, 352, NW, 'Deploy identity', ['AWS deploy role or Azure', 'managed identity; trusts', 'only this tenant’s subject'], {stroke:C.cust});

const tf = f.node(NX.gh, 462, NW, 'Terraform provisioning', ['golden images copied in;', 'terraform init + apply']);
const infra = f.node(NX.cu, 462, NW, 'Chatbot infrastructure', ['containers, storage, signer,', 'vector DB; state kept here'], {stroke:C.cust});

const report = f.node(NX.gh, 558, NW, 'Outcome reporting', ['status callback with the', 'chatbot and signer URLs']);
const record = f.node(NX.cp, 558, NW, 'Tenant recorded', ['live or failed; a lost', 'callback is recovered by', 'polling and reconciliation']);

[[boot, 1], [onboard, 2], [dispatch, 3], [oidc, 4], [tf, 5], [report, 6]].forEach(([n, i]) => f.badge(n.x, n.y, i));

// ── flow ────────────────────────────────────────────────────────────────
const cpMid = NX.cp + NW / 2, ghMid = NX.gh + NW / 2;
f.arrow([[boot.x, mid(boot)], [cpMid, mid(boot)], [cpMid, onboard.y]]);
f.label(ghMid, mid(boot) - 7, 'IDs entered at onboarding', {anchor:'middle'});

f.arrow([[onboard.r, mid(onboard)], [sm.x, mid(onboard)]]);
f.label(ghMid, mid(onboard) - 7, 'AWS: AssumeRole + ExternalId', {anchor:'middle', fill:C.aws});
f.label(ghMid, mid(onboard) + 16, 'write-only', {anchor:'middle', fill:C.aws});

f.arrow([[cpMid, onboard.b], [cpMid, dispatch.y]]);
f.arrow([[dispatch.r, mid(dispatch)], [ghMid, mid(dispatch)], [ghMid, oidc.y]]);
f.label((dispatch.r + ghMid) / 2 + 20, mid(dispatch) - 7, 'starts the run', {anchor:'middle'});

f.arrow([[oidc.r, mid(oidc)], [identity.x, mid(oidc)]]);
f.arrow([[oidc.x, mid(oidc)], [release.r, mid(oidc)]], 'reply');

f.arrow([[ghMid, oidc.b], [ghMid, tf.y]]);
f.arrow([[tf.r, mid(tf)], [infra.x, mid(tf)]]);
f.arrow([[ghMid, tf.b], [ghMid, report.y]]);
f.arrow([[report.x, mid(report)], [record.r, mid(report)]]);

// ── lanes (drawn under everything) ──────────────────────────────────────
const LB = 640;
f.group(LANE.cp, 16, LANE.w, LB - 16, 'CONTROL PLANE', {fill:C.cpTint, stroke:C.cp});
f.group(LANE.gh, 16, LANE.w, LB - 16, 'GITHUB ACTIONS RUN', {fill:C.ghTint, stroke:C.gh, nameFill:C.sec});
f.group(LANE.cu, 16, LANE.w, LB - 16, 'CUSTOMER CLOUD', {fill:C.custTint, stroke:C.cust});

f.legend(664, [['flow', 'next step or call'], ['reply', 'the run calls the platform'], ['badge', 'stage']]);

const H = 680;
render('fig-4-2-deployment-workflow', f.svg(H, 'Deployment workflow in three lanes. The customer runs a one-time bootstrap template; the control plane validates onboarding, on AWS writes the keys into the customer’s Secrets Manager through a write-only role bound by ExternalId, and dispatches a workflow. The GitHub Actions run authenticates with its OIDC token to the customer’s deploy identity, on Azure fetching the keys from the platform once, provisions the chatbot with Terraform, and reports the outcome, which the control plane records, with polling and reconciliation covering a lost callback.'), H);
