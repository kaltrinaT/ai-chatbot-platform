/* eslint-disable @typescript-eslint/no-require-imports -- Standalone CommonJS figure script. */
// Figure 4.1 — Overall system architecture.
//
//   node scripts/thesis-figures/fig-4-1-system-architecture.cjs
//
// Control plane, GitHub Actions, the customer-owned data plane on either cloud,
// and the third-party services the chatbot calls. Components follow
// infra/terraform/main.tf (AWS), infra/terraform/azure/main.tf (Azure),
// infra/platform/* (the platform's own AWS account) and src/ (the app).
const {C, figure, render} = require('./lib.cjs');

const f = figure();

// ── control plane and GitHub ────────────────────────────────────────────
f.group(16, 64, 400, 140, 'CONTROL PLANE', {fill:C.cpTint, stroke:C.cp});
f.node(28, 106, 116, 'Platform AWS', ['golden images', 'platform role']);
f.node(158, 106, 116, 'Neon Postgres', ['tenant records', 'encrypted keys']);
const app = f.node(288, 106, 116, 'Platform app', ['Next.js, Vercel', 'server actions']);

f.group(452, 64, 252, 140, 'GITHUB', {fill:C.ghTint, stroke:C.gh, nameFill:C.sec});
const gha = f.node(464, 106, 228, 'Actions workflows', ['deploy · destroy · verify', 'Terraform runner', 'per-job OIDC token']);

const op = f.node(270, 14, 152, 'Operator', [], {h:34});
f.arrow([[app.cx, op.b], [app.cx, app.y]]);
f.label(app.cx + 8, 90, 'GitHub sign-in');

f.arrow([[app.r, 132], [gha.x, 132]]);
f.label((app.r + gha.x) / 2, 125, 'dispatch', {anchor:'middle'});
f.arrow([[gha.x, 162], [app.r, 162]], 'reply');
f.label((app.r + gha.x) / 2, 155, 'status', {anchor:'middle'});

// ── data plane ──────────────────────────────────────────────────────────
const DP = {y:252, b:476};
f.group(16, DP.y, 688, DP.b - DP.y, 'DATA PLANE · CUSTOMER-OWNED, ONE PER TENANT', {fill:'#f7fbf9', stroke:C.cust});

const cloud = (x, name, color, chips) => {
  f.group(x, 284, 328, 178, name, {fill:C.custTint, stroke:C.cust, nameFill:color});
  chips.forEach((label, i) => f.chip(x + 12 + (i % 2) * 157, 314 + Math.floor(i / 2) * 36, 147, label));
};
cloud(28, 'AWS ACCOUNT', C.aws, [
  'ALB (+ CloudFront)', 'ECS Fargate: UI + API',
  'S3 documents', 'Lambda docs-signer',
  'Secrets Manager', 'RDS pgvector (optional)',
  'ECR images', 'Terraform state (S3)',
]);
cloud(364, 'AZURE SUBSCRIPTION', C.az, [
  'Container Apps: UI + API', 'Blob documents',
  'Function docs-signer', 'Key Vault',
  'pgvector DB (optional)', 'ACR images',
  'Log Analytics', 'Terraform state (Blob)',
]);

f.arrow([[app.cx, app.b], [app.cx, DP.y]], 'reply');
f.label(app.cx - 8, 226, 'documents: signer calls,', {anchor:'end'});
f.label(app.cx - 8, 240, 'POST /api/index', {anchor:'end'});
f.arrow([[gha.cx, gha.b], [gha.cx, DP.y]]);
f.label(gha.cx - 8, 226, 'OIDC sign-in,', {anchor:'end'});
f.label(gha.cx - 8, 240, 'Terraform apply', {anchor:'end'});

// ── users and third parties ─────────────────────────────────────────────
const users = f.node(24, 530, 152, 'End users', ['chat with a', 'tenant’s chatbot']);
f.arrow([[users.cx, users.y], [users.cx, DP.b]]);
f.label(users.cx + 8, 506, 'HTTPS');

f.group(200, 500, 504, 106, 'EXTERNAL SERVICES', {fill:'#ffffff', stroke:C.ext, nameFill:C.sec, dash:true});
f.node(212, 530, 154, 'LLM provider', ['OpenAI, Anthropic', 'or OpenRouter'], {dash:true, stroke:C.ext});
f.node(379, 530, 154, 'Pinecone', ['vector index', '(optional)'], {dash:true, stroke:C.ext});
f.node(546, 530, 146, 'Hugging Face', ['embedding model', 'at first use'], {dash:true, stroke:C.ext});
f.arrow([[452, DP.b], [452, 500]]);
f.label(460, 492, 'called by the chatbot');

const H = 622;
render('fig-4-1-system-architecture', f.svg(H, 'Overall system architecture: an operator manages tenants in the control plane, which dispatches GitHub Actions workflows; the workflows sign in to the customer-owned AWS or Azure data plane through OIDC and apply Terraform. The data plane hosts the chatbot, documents, signer, secrets and optional pgvector database, and calls an external LLM provider, optionally Pinecone, and Hugging Face for the embedding model.'), H);
