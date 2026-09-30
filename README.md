# AI Chatbot Platform

A control plane that deploys a retrieval-augmented chatbot into each customer's **own** AWS account or Azure subscription, one isolated stack per tenant. The platform never sees chat traffic, documents or logs, and holds no credential for any customer cloud: the customer's one-click setup creates an identity that trusts only that chatbot's GitHub Actions runs, and every deploy signs in with a token GitHub issues for the run.

It is a Next.js application backed by Postgres. Deployments run as GitHub Actions workflows that apply Terraform in the customer's cloud, with the Terraform state kept there too.

## Documentation

| Document | Covers |
|---|---|
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | The control-plane / data-plane boundary, per-tenant infrastructure on both clouds, secret and credential flows, data model |
| [`DOCS.md`](DOCS.md) | Reference: routes, database schema, onboarding flow, workflows, Terraform variables, environment variables, cost model |
| [`docs/DEPLOYMENT-AWS-VS-AZURE.md`](docs/DEPLOYMENT-AWS-VS-AZURE.md) | A deployment step by step on each cloud, and how the two paths compare |
| [`CLIENT-DEPLOYMENT-GUIDE.md`](CLIENT-DEPLOYMENT-GUIDE.md) | What a customer prepares in their own cloud, and what to expect afterwards |
| [`DOCUMENT-MANAGEMENT.md`](DOCUMENT-MANAGEMENT.md) | Uploading and deleting knowledge-base documents without the platform holding a storage credential |
| [`CHATBOT-LOGIC.md`](CHATBOT-LOGIC.md) | What the deployed chatbot does: indexing, retrieval, prompting, configuration |
| [`SECURITY.md`](SECURITY.md) | Credential inventory, the trust model on each cloud, and known security limitations |
| [`LIMITATIONS.md`](LIMITATIONS.md) | Known architectural limitations, and why each exists |
| [`EVALUATION.md`](EVALUATION.md) | How the platform's claims are to be evaluated |
| [`docs/figures/`](docs/figures/) | The figures the documents refer to |

The chatbot backend itself lives in the separate `ai-chatbot/ai-backend` repository.

## Running locally

1. `npm install`
2. Copy [`.env.example`](.env.example) to `.env.local` and fill it in. Each variable is explained there; the AWS ones assume the one-time setup in [`infra/platform/`](infra/platform/).
3. Apply the database schema to your Postgres database (`npm run db:migrate`).
4. `npm run dev`, then open [http://localhost:3000](http://localhost:3000).

The deploy workflows reach the platform at the `PLATFORM_BASE_URL` repository secret, which must be publicly reachable. Browser uploads to a tenant's storage are accepted only from that address and the optional `EXTRA_CORS_ORIGIN` repository variable, so a platform run at `localhost:3000` needs `EXTRA_CORS_ORIGIN=http://localhost:3000`, followed by a redeploy of each tenant (`LIMITATIONS.md` #7).

## Tests

`npm test` runs the Vitest suite. Much of it checks the infrastructure code as source — the workflows, Terraform and setup templates — for the security properties the documents claim.
