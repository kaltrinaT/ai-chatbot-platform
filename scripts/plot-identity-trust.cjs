/* eslint-disable @typescript-eslint/no-require-imports -- Standalone CommonJS figure script. */
// Thesis figure: the identity trust graph, both clouds in one picture.
//
//   fig-28-identity-trust   every identity in the system, every way one becomes
//                           or authenticates to another, and what each binds to
//
//   node scripts/plot-identity-trust.cjs
//
// Drawn from the trust policies as written, not from a live account:
// infra/platform/control-plane/main.tf and infra/platform/github-oidc/main.tf
// (the platform's two AWS roles), infra/bootstrap/aws/tenant-bootstrap.yaml and
// infra/bootstrap/azure/tenant-bootstrap.json (the customer's deploy and
// onboarding identities), infra/terraform/main.tf and infra/terraform/azure/
// main.tf (runtime identities), src/auth.ts, src/lib/deploymentSecrets.ts and
// src/app/api/deployments/[id]/status/route.ts (what the platform accepts).
// A deployed account can lag the code; the security evaluation's S2 test reads
// the deployed policy as well. Writes SVG and a print-resolution PNG into
// docs/figures/, in the colours and type of the other figures there.
const fs = require('node:fs');
const sharp = require('sharp');

const out = 'docs/figures';
const W = 960;
const C = {
  ink:'#16181d', sec:'#3d4350', mut:'#5b6270', warn:'#a13b12', rule:'#c9ccd2',
  aws:'#b4540a', az:'#1f5fae',
  cust:'#146b58', custTint:'#e9f3ef', cpTint:'#eef1f6',
  note:'#f7f7f4', noteLine:'#c9c8bf',
};
const esc = s => String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const text = (x, y, s, {size = 14, fill = C.ink, weight, anchor, family} = {}) =>
  `<text x="${x}" y="${y}" font-size="${size}"${weight ? ` font-weight="${weight}"` : ''}${anchor ? ` text-anchor="${anchor}"` : ''}${family ? ` font-family="${family}"` : ''} fill="${fill}">${esc(s)}</text>`;
const MONO = "Consolas, 'Courier New', monospace";

const body = [];
const add = s => body.push(s);
const LINE = 14;

// An identity. `name` is its resource name, set in monospace under the title.
// `lines` entries may be [text, {family, fill}] for a line styled apart.
function node(x, y, w, title, {name, lines = [], stroke = C.sec} = {}){
  const first = name ? 52 : 37;
  const h = first + (lines.length - 1) * LINE + 11;
  add(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="4" fill="#ffffff" stroke="${stroke}" stroke-width="1.2"/>`);
  add(text(x + 12, y + 20, title, {size:13.5, weight:'bold'}));
  if(name) add(text(x + 12, y + 36, name, {size:11, fill:C.sec, family:MONO}));
  lines.forEach((l, i) => {
    const [s, o] = Array.isArray(l) ? l : [l, {}];
    add(text(x + 12, y + first + i * LINE, s, {size:12, fill:C.mut, ...o}));
  });
  return {x, y, w, h, bottom:y + h};
}
// kind: 'identity' (assumes or federates into) · 'request' (authenticates one
// request) · 'refused'
function edge(points, kind = 'identity'){
  const pts = points.map(p => p.join(',')).join(' ');
  const style = {
    identity: `stroke="${C.ink}" stroke-width="1.5" marker-end="url(#f-ink)"`,
    request: `stroke="${C.ink}" stroke-width="1.5" stroke-dasharray="6 4" marker-end="url(#o-ink)"`,
    refused: `stroke="${C.warn}" stroke-width="1.5" stroke-dasharray="6 4" marker-end="url(#f-warn)"`,
  }[kind];
  add(`<polyline points="${pts}" fill="none" ${style}/>`);
}
function badge(x, y, label, fill = C.sec){
  add(`<circle cx="${x}" cy="${y}" r="9" fill="${fill}" stroke="#ffffff" stroke-width="1.5"/>`);
  add(text(x, y + 3.8, label, {size:label.length > 1 ? 9.5 : 10.5, weight:'bold', fill:'#ffffff', anchor:'middle'}));
}

// ── platform ────────────────────────────────────────────────────────────
const operator = node(28, 70, 122, 'Operator', {lines:['a person with a', 'GitHub account']});
const app = node(186, 64, 236, 'Platform app', {lines:[
  'Next.js on Vercel, production',
  'holds GITHUB_PAT, the webhook',
  'secret and the signer secrets',
  '(encrypted); no cloud credential',
]});
const acct = {x:446, y:48, w:486, h:144};
const pull = node(458, 78, 222, 'Image-pull role', {lines:[
  'used by deploy runs to pull',
  'the golden images; assumes',
  'no customer role',
]});
const plat = node(700, 78, 220, 'Platform role', {lines:[
  'the app’s only AWS identity:',
  'may assume chatbot-client-',
  'onboard-* roles, nothing else',
]});

edge([[operator.x + operator.w, 100], [app.x, 100]]);
badge(168, 86, '1');
edge([[404, app.y], [404, 34], [810, 34], [810, plat.y]]);
badge(607, 34, '2');

// ── GitHub ──────────────────────────────────────────────────────────────
const run = node(186, 228, 514, 'Workflow run in GitHub environment tenant-{id}', {lines:[
  'each job gets a GitHub-signed OIDC token whose subject is',
  ['repo:{owner}/{repo}:environment:tenant-{id}', {family:MONO, fill:C.sec, size:11.5}],
  'whoever controls the workflows can name any tenant (limitation 8)',
]});

edge([[230, app.bottom], [230, run.y]], 'request');
badge(230, 182, '4');
edge([[316, run.y], [316, app.bottom]], 'request');
badge(316, 182, '8');
edge([[390, run.y], [390, app.bottom]], 'request');
badge(390, 182, '9');
edge([[640, run.y], [640, pull.bottom]]);
badge(640, 206, '7');

// ── customer clouds ─────────────────────────────────────────────────────
const CY = 362;
const azDeploy = node(28, CY, 422, 'Deploy identity', {
  name:'chatbot-deploy-{slug}  (user-assigned managed identity)',
  lines:[
    'federated credential: GitHub issuer, this tenant’s subject only',
    'Contributor + User Access Administrator on chatbot-{slug}:',
    'everything in that group, nothing outside it',
  ],
  stroke:C.cust,
});
const azRuntime = node(28, azDeploy.bottom + 24, 422, 'Runtime identities', {lines:[
  'chatbot (user-assigned): pull images, read documents',
  'docs-signer (system-assigned): write and delete, never read',
], stroke:C.cust});

const awsDeploy = node(486, CY, 222, 'Deploy role', {
  name:'chatbot-client-deploy-{slug}',
  lines:['trusts one GitHub subject;', 'builds the chatbot, so it can', 'read its documents and secrets'],
  stroke:C.cust,
});
node(720, CY, 212, 'Onboarding role', {
  name:'chatbot-client-onboard-{slug}',
  lines:['trusts the platform account', 'with ExternalId = tenant id', 'may write secrets, read none'],
  stroke:C.cust,
});
const awsRuntime = node(486, awsDeploy.bottom + 24, 446, 'Runtime roles', {
  name:'chatbot-{slug}-*',
  lines:[
    'assumable only by ECS tasks and Lambda, capped by a boundary',
    'task: list and read documents · signer: write and delete, never read',
  ],
  stroke:C.cust,
});

edge([[300, run.bottom], [300, CY]]);
badge(300, 339, '6');
edge([[600, run.bottom], [600, CY]]);
badge(600, 339, '5');
edge([[860, plat.bottom], [860, CY]]);
badge(860, 270, '3');
edge([[716, plat.bottom], [716, 338], [680, 338], [680, CY]], 'refused');
badge(716, 270, '✕', C.warn);
edge([[597, awsDeploy.bottom], [597, awsRuntime.y]]);
badge(619, (awsDeploy.bottom + awsRuntime.y) / 2, '10');
edge([[240, azDeploy.bottom], [240, azRuntime.y]]);
badge(262, (azDeploy.bottom + azRuntime.y) / 2, '11');

const cloudBottom = Math.max(azRuntime.bottom, awsRuntime.bottom) + 44;

// ── bands (drawn under everything else) ─────────────────────────────────
const under = [
  `<rect x="16" y="16" width="928" height="184" rx="6" fill="${C.cpTint}" stroke="${C.sec}" stroke-width="1.4"/>`,
  text(28, 38, 'PLATFORM', {size:13, weight:'bold', fill:C.sec}),
  text(110, 38, 'run by its owner', {size:12, fill:C.mut}),
  `<rect x="${acct.x}" y="${acct.y}" width="${acct.w}" height="${acct.h}" rx="4" fill="#f9fafc" stroke="${C.sec}" stroke-width="1"/>`,
  text(acct.x + 12, acct.y + 18, 'PLATFORM AWS ACCOUNT', {size:11.5, weight:'bold', fill:C.aws}),

  `<rect x="16" y="212" width="928" height="120" rx="6" fill="${C.note}" stroke="${C.noteLine}" stroke-width="1.2"/>`,
  text(28, 236, 'GITHUB', {size:13, weight:'bold', fill:C.sec}),
  ...['the deploy', 'repository is', 'the trust anchor'].map((l, i) => text(28, 254 + i * LINE, l, {size:12, fill:C.mut})),

  `<rect x="16" y="346" width="446" height="${cloudBottom - 346}" rx="6" fill="${C.custTint}" stroke="${C.cust}" stroke-width="1.5"/>`,
  text(28, cloudBottom - 26, 'CUSTOMER AZURE SUBSCRIPTION', {size:12, weight:'bold', fill:C.az}),
  text(28, cloudBottom - 11, 'no onboarding identity: the platform makes no Azure call', {size:12, fill:C.mut}),
  `<rect x="474" y="346" width="470" height="${cloudBottom - 346}" rx="6" fill="${C.custTint}" stroke="${C.cust}" stroke-width="1.5"/>`,
  text(486, cloudBottom - 26, 'CUSTOMER AWS ACCOUNT', {size:12, weight:'bold', fill:C.aws}),
  text(486, cloudBottom - 11, 'one deploy role and one onboarding role per tenant', {size:12, fill:C.mut}),
];

// ── key ─────────────────────────────────────────────────────────────────
// What each edge needs, which the graph has no room to print on the lines.
const KEY = [
  ['1', 'Operator → platform app', 'GitHub OAuth sign-in', 'a database session; an e-mail allow-list when one is set'],
  ['2', 'Platform app → platform role', 'Vercel OIDC, or the operator’s AWS sign-in', 'subject names the production deployment; temporary credentials only'],
  ['3', 'Platform role → onboarding role', 'sts:AssumeRole', 'sts:ExternalId = tenant id'],
  ['4', 'Platform app → workflow run', 'workflow_dispatch with GITHUB_PAT', 'the run executes only the workflow’s own steps (S9)'],
  ['5', 'Run → AWS deploy role', 'AssumeRoleWithWebIdentity', 'aud sts.amazonaws.com; sub equals …:environment:tenant-{id}'],
  ['6', 'Run → Azure deploy identity', 'federated credential exchange', 'aud api://AzureADTokenExchange; the same subject, exactly'],
  ['7', 'Run → image-pull role', 'AssumeRoleWithWebIdentity', 'sub matches …:environment:tenant-* (a wildcard; reaches no tenant)'],
  ['8', 'Run → platform /secrets', 'OIDC token for the platform’s audience', 'repository, subject, workflow_ref; released once; Azure only'],
  ['9', 'Run → platform /status', 'x-webhook-secret header', 'constant-time compare; a finished deployment answers 409'],
  ['10', 'Deploy role → runtime roles', 'creates and passes them', 'named chatbot-{slug}-*, boundary attached, ECS and Lambda only'],
  ['11', 'Deploy identity → runtime identities', 'role assignments', 'inside resource group chatbot-{slug}'],
  ['✕', 'Platform role → deploy role', 'refused', 'absent from the platform policy and from the role’s trust (S2)'],
];
const KX = {n:28, edge:52, how:280, bound:540};
let y = cloudBottom + 30;
add(text(KX.edge, y, 'Edge', {size:11.5, weight:'bold', fill:C.sec}));
add(text(KX.how, y, 'How', {size:11.5, weight:'bold', fill:C.sec}));
add(text(KX.bound, y, 'Bound to', {size:11.5, weight:'bold', fill:C.sec}));
add(`<line x1="20" y1="${y + 6}" x2="940" y2="${y + 6}" stroke="${C.rule}" stroke-width="1"/>`);
y += 10;
for(const [n, e, how, bound] of KEY){
  y += 17;
  const refused = n === '✕';
  badge(KX.n + 9, y - 4, n, refused ? C.warn : C.sec);
  add(text(KX.edge, y, e, {size:11.5, fill:C.ink}));
  add(text(KX.how, y, how, {size:11.5, fill:refused ? C.warn : C.mut}));
  add(text(KX.bound, y, bound, {size:11.5, fill:C.sec}));
}

// ── legend ──────────────────────────────────────────────────────────────
y += 32;
{
  let lx = 28;
  const item = (kind, label) => {
    edge([[lx, y - 4], [lx + 44, y - 4]], kind);
    add(text(lx + 54, y, label, {size:12.5, fill:C.sec}));
    lx += 54 + label.length * 6.6 + 30;
  };
  item('identity', 'assumes or federates into');
  item('request', 'authenticates one request');
  item('refused', 'refused');
}
const H = y + 18;

const marker = (id, color, open) => `<marker id="${id}" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="7" markerHeight="7" orient="auto">${open
  ? `<path d="M1,1 L9.5,5 L1,9" fill="none" stroke="${color}" stroke-width="1.4" stroke-linejoin="round"/>`
  : `<path d="M0,0 L10,5 L0,10 z" fill="${color}"/>`}</marker>`;
const defs = [marker('f-ink', C.ink, false), marker('o-ink', C.ink, true), marker('f-warn', C.warn, false)].join('');

const label = 'Identity trust graph. The platform app reaches AWS only through its platform role, which may assume each customer’s write-only onboarding role under that tenant’s ExternalId and is refused by the deploy role. Deploys reach both clouds as a GitHub Actions run whose OIDC subject names one tenant’s environment, which the customer’s deploy role and federated credential each match exactly; the deploy identities in turn create the runtime identities that touch documents.';
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(label)}">
  <rect x="0" y="0" width="${W}" height="${H}" fill="#ffffff"/>
  <defs>${defs}</defs>
  <g font-family="Arial, Helvetica, sans-serif">${under.join('')}${body.join('')}</g>
</svg>
`;

(async () => {
  const name = 'fig-28-identity-trust';
  fs.writeFileSync(`${out}/${name}.svg`, svg);
  await sharp(Buffer.from(svg), {density:216}).png().toFile(`${out}/${name}.png`);
  console.log(`Wrote ${out}/${name}.svg and .png (${W}×${H})`);
})();
