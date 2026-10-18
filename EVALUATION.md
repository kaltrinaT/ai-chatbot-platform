# Evaluation Methodology

> **Status: plan, not results.** This document defines *how* the platform is to
> be evaluated and *what* will be measured. Every numeric cell in the tables
> below is a placeholder (`—`) until the corresponding experiment has been run.
> No figure in this document contains measured data yet. The exception is the
> evidence matrix (§1.1), which links each claim to results already archived
> under `docs/evaluation/`.

---

## 1. The Claim Under Evaluation

The platform's contribution is not a RAG chatbot. It is a **control plane that
provisions isolated, customer-owned RAG deployments across two clouds without
ever entering the data plane** (`ARCHITECTURE.md`, "Control Plane / Data Plane
Boundary").

That decomposes into three evaluable propositions:

| # | Proposition | Evaluated by |
|---|---|---|
| **C1** | One click replaces a substantial manual provisioning effort | EA1 |
| **C2** | It does so within a predictable time, reliably, at a predictable cost | EA2, EA4 |
| **C3** | The isolation and control-plane-blindness claims are *real*, not merely documented | EA3 |

C3 is the proposition that distinguishes this work from an ordinary deployment
script, and it is the one that must be demonstrated empirically rather than
asserted. `SECURITY.md` states the boundaries; this document tests them.

### 1.1 Evidence Matrix

Every claim the thesis makes about the platform, the experiment that would
support it, and the evidence that exists. A claim whose status is not
**Done** is not reported as a result. Statuses reflect the archived reports
in `docs/evaluation/` (automated and security: 2026-10-11; OIDC: database
extraction 2026-10-09; deployment timings, RAG isolation and mutation testing:
2026-10-18).

| # | Claim | Experiment | Metric / evidence | Pass criterion | Status | Evidence so far |
|---|---|---|---|---|---|---|
| E1 | Deployment is automated | End-to-end deployment from the wizard to `T7` (§4) | Operator inputs, manual steps outside the platform, duration `T5 − T0` and `T7 − T0` | No manual step between Deploy and `T5`; inputs = the wizard's required fields | **Partial** | 3 OIDC deployments succeeded with no manual step (1 AWS 9.01 min; 2 Azure 8.65 and 19.81 min) — `docs/evaluation/oidc/REPORT.md`. Over all 105 archived runs, successful first deploys took a median 10.3 min (AWS pgvector, n = 10), 7.0 (AWS Pinecone, n = 2) and 14.1 (Azure pgvector, n = 2); GitHub's queue a median 6 s — `docs/evaluation/deployment-timing/REPORT.md`, §4. Required inputs 5 (AWS) / 7 (Azure) — §3. `T7` never measured; the one live tenant probed returned no HTTP response — `docs/evaluation/automated/REPORT.md` |
| E2 | Provisioning is repeatable | Repeated fresh deployments of one cell with identical inputs | Success rate; resource inventory per run (types and counts) | Every run succeeds and creates an equivalent resource set | **To do** (history read; campaign ready) | The 105 runs span 44 configuration versions and none has five successes, so they do not qualify. Where two clean first deploys of one version exist, each pair planned an identical resource set (42 and 38 resources) — §4. Campaign: `docs/evaluation/live/RUNBOOK.md` |
| E3 | Terraform is idempotent | Re-dispatch a deploy against an already-deployed tenant (§4, Idempotency) | `terraform plan` add / change / destroy counts | `0 to add, 0 to change, 0 to destroy` and the run succeeds | **Partial** | Of four historical redeploys at the same version as the deploy before them, three planned no change and one updated the docs-signer Lambda in place (at `55143b8+2eade1e`) — §4. The current version is untested |
| E4 | Cleanup works | Teardown workflow, then inventory the account or subscription (§4, Destroy/onboard cycle) | Resources remaining after destroy, by type | Nothing remains except documented exceptions (Azure resource group left for the customer; soft-deleted Key Vault) | **To do** | No teardown has a post-destroy inventory. Every AWS teardown whose tenant's deploy log survived destroyed fewer resources than the deploy planned (3 of 42; 31–35 of 38–43), which an inventory has to explain — §4 |
| E5 | No standing deployment credentials | Configuration inspection plus live OIDC sign-in | Credentials the platform holds per cloud; OIDC login step outcome; trust-policy decisions | 0 stored cloud credentials; every deploy signs in through OIDC; foreign subjects refused | **Done** (live half of S8 open) | 10/10 customer OIDC login steps succeeded, no client secret in any workflow — `docs/evaluation/oidc/REPORT.md`. S2, S7 PASS; S8 PASS (static) — `docs/evaluation/security/REPORT.md` |
| E6 | Tenant boundaries hold | Cross-tenant negative tests: S1 (chatbot retrieval) and S10 (operator access) | Denied requests; canary leakage | Every cross-tenant request is refused or leaks nothing; each paired control succeeds | **Partial** (S10 Pass, S1 to do) | S10 **PASS** after the S10.5 fix: a connection check naming another operator's tenant is now refused (report regenerated 2026-10-17; the live Vercel copy carries the fix only once deployed). S1 not run (needs two tenants live at once) — `docs/evaluation/security/REPORT.md`. Its local stand-in SEC-RAG-01 **PASS**: the evaluated backend image, run as two tenants sharing one pgvector table, leaked nothing on 18 probes (answer, sources and the LLM's input) or 6 reindex checks, while the same probes caught a copy with the tenant filter removed — `docs/evaluation/rag-isolation/REPORT.md` |
| E7 | RAG retrieves client knowledge | Fixed QA set over a fixed corpus (§7) | Expected-source rate: answers whose `sources` include the expected document | Defined before the run (rubric fixed in advance) | **To do** | — |
| E8 | Answers are grounded | Same fixed QA set | Correctness and faithfulness scored against a pre-fixed rubric | Defined before the run | **To do** | — |
| E9 | Unknown information is rejected | Unanswerable question set over the same corpus | Abstention rate; any fabricated answer counts as a failure | Defined before the run | **To do** | — |
| E10 | Knowledge follows the document lifecycle | Canary test: ask before upload, after upload, after delete | Canary present in answer or `sources` at each stage | Absent → present → absent | **To do** | — |

The rows that need a deployed chatbot (E1, E3, E4, E7–E10, S1, S4) are run by
`scripts/evaluate-live.cjs`, one subcommand per row, in the order given in
`docs/evaluation/live/RUNBOOK.md`. E7–E9 use the backend's own golden set and
fixture corpus (`docs/evaluation/live/golden.json`, 19 cases) and are scored
deterministically: expected source cited, expected facts present, abstention on
unanswerable questions. Faithfulness and the three adversarial cases are scored
by hand against the rubric recorded with the results.

E7–E9 go beyond the original EA5 scope (§7), which deliberately avoided a
RAG-quality study. They treat the deployed tenant as a black box, so they
measure what the platform delivered to the customer, not the backend's
internals. The construct threat in §10 applies: a weak result may be caused by
the backend rather than the platform.

Supporting propositions — that the deployed artefact functions equivalently
across configurations (EA5) and that the onboarding interface is usable by its
target operator (EA6) — are evaluated at lower depth.

```
                        ┌──────────────────────────────┐
                        │   C1  effort reduction       │◄── EA1  baseline study
                        └──────────────────────────────┘
   "one-click, BYOC,    ┌──────────────────────────────┐◄── EA2  40-run campaign
    blind control  ────►│   C2  predictable & reliable │
    plane"              └──────────────────────────────┘◄── EA4  cost validation
                        ┌──────────────────────────────┐
                        │   C3  isolation is real      │◄── EA3  adversarial tests
                        └──────────────────────────────┘
                                     ▲
                        supporting:  EA5 configuration equivalence
                                     EA6 operator usability
```

---

## 2. Experimental Spine: the Configuration Matrix

Two independent design choices are exposed per tenant — `cloudProvider` and
`vectorStore` (`src/db/schema.ts`). Their cross-product defines four cells, and
**every quantitative measurement in EA2, EA4 and EA5 is reported per cell.**

```
                        vector_store
                 ┌──────────────┬──────────────┐
                 │   pinecone   │   pgvector   │
    ┌────────────┼──────────────┼──────────────┤
    │            │              │              │
    │    aws     │      A1      │      A2      │
    │            │  ECS + 3rd-  │  ECS + RDS   │
 c  │            │  party index │  pgvector    │
 l  ├────────────┼──────────────┼──────────────┤
 o  │            │              │              │
 u  │   azure    │      B1      │      B2      │
 d  │            │  Container   │  Container   │
    │            │  App + 3rd-  │  App + Azure │
    │            │  party index │  PG pgvector │
    └────────────┴──────────────┴──────────────┘

    A2/B2 keep embeddings inside the customer account (residency-preserving)
    A1/B1 export embeddings to us-east-1 regardless of tenant region
          → see Known Limitation #6, SECURITY.md
```

The matrix is not incidental. The `pgvector` column exists specifically to
answer the residency objection that the `pinecone` column raises, so comparing
the two columns on time, cost and isolation *is* the evaluation of that design
decision.

**Replication.** n = 10 deployments per cell → 40 deployment runs total, plus
40 teardowns. Each run is a fresh tenant slug; no cell reuses infrastructure.

---

## 3. Evaluation Axis 1 — Effort Reduction (C1)

**RQ1.** How much operator effort does the platform remove relative to
provisioning the same infrastructure by hand?

### Method

A **manual baseline** is performed once per cloud: the same target
infrastructure is provisioned by hand from the cloud console and CLI, with the
operator logging every discrete step, its wall-clock duration, and any error or
backtrack. n = 1 per cloud is a deliberate limitation (see §10), justified by
the cost of the procedure and mitigated by reporting structural measures that
do not depend on operator speed.

### Structural measures (derivable from the repository, no experiment needed)

| Measure | AWS | Azure | Source |
|---|---|---|---|
| Terraform resources provisioned | **41** | **24** | `infra/terraform/*.tf`, `infra/terraform/azure/*.tf` |
| Terraform input variables | **24** | **25** | `variables.tf` in each root |
| Wizard steps presented to operator | **4 input + 1 deploy** | same | `src/app/tenants/new/wizard/steps.ts` |
| Required fields before submit | 5 | 7 | `REQUIRED_BY_STEP` + `REQUIRED_BY_CLOUD` |

The gap between *24–25 Terraform variables* and *5–7 required form fields* is
itself a finding: the platform derives the remainder from defaults, naming
conventions and cloud lookups.

### Measured comparison

| Measure | Manual (AWS) | Platform (AWS) | Manual (Azure) | Platform (Azure) |
|---|---|---|---|---|
| Operator wall-clock to working chatbot | — | — | — | — |
| Discrete operator actions | — | — | — | — |
| Distinct consoles / CLIs touched | — | 1 | — | 1 |
| Configuration values typed by hand | — | — | — | — |
| Steps handling a plaintext credential | — | — | — | — |
| Backtracks / errors encountered | — | — | — | — |

The credential-handling row matters beyond ergonomics: each manual step in
which a key is pasted into a console is an opportunity for it to land in shell
history, a screenshot, or a support ticket. Reducing that count is a security
result, not only a usability one.

---

## 4. Evaluation Axis 2 — Deployment Performance and Reliability (C2)

**RQ2.** How long does an automated deployment take, how is that time
distributed across phases, and how reliably does it succeed?

### Measurement points

Timestamps are captured at the boundaries below. `T0`–`T6` come from the
GitHub Actions run; `T7`–`T8` are measured by an external probe after the
workflow reports success.

```
  operator clicks Deploy
        │
        ▼
  T0 ── workflow_dispatch accepted            src/lib/deploy.ts
        │                                      deployments.startedAt
        │   ⟨ GitHub queue latency ⟩
        ▼
  T1 ── "Notify platform — run started"       POST /status {running}
        │
        │   ⟨ P1  image pull + replication ⟩  Pull source images
        ▼                                      Replicate images to client ECR
  T2 ── images present in customer registry
        │
        │   ⟨ P2  terraform init ⟩            Terraform init
        ▼
  T3 ── providers downloaded, backend ready
        │
        │   ⟨ P3  terraform apply ⟩           Terraform apply — on Azure two
        ▼                                      applies with a 90 s pause between
                                               (46 AWS / 26 Azure resource blocks
                                               declared; how many a cell creates
                                               depends on its vector store and, on
                                               AWS, its HTTPS route)
  T4 ── infrastructure created
        │
        │   ⟨ P4  outputs + callback ⟩        Read Terraform outputs
        ▼                                      Notify platform — success
  T5 ── deployments.finishedAt = succeeded
        │
        │   ⟨ P5  service convergence ⟩       external probe:
        ▼                                      GET /api/health → 200
  T6 ── backend healthy
        │
        │   ⟨ P6  first answer ⟩              external probe:
        ▼                                      POST /api/ask → grounded answer
  T7 ── chatbot answers a question about an uploaded document
```

`T5` is where the platform currently declares success. **`T7` is the honest
definition of "deployed"** — a thesis result that stops at `T5` overstates the
system. Report both, and report `T7 − T5` as a distinct quantity, because it is
time the operator waits with no feedback from the UI.

### Reported per cell

| Metric | A1 | A2 | B1 | B2 |
|---|---|---|---|---|
| End-to-end `T7 − T0` — mean ± SD | — | — | — | — |
| Workflow time `T5 − T0` — mean ± SD | — | — | — | — |
| P1 image replication | — | — | — | — |
| P2 terraform init | — | — | — | — |
| P3 terraform apply | — | — | — | — |
| P5 service convergence | — | — | — | — |
| P6 first grounded answer | — | — | — | — |
| min / max end-to-end | — | — | — | — |
| Success rate (n = 10) | — | — | — | — |
| Teardown `destroy-tenant.yml` / `destroy-tenant-azure.yml` | — | — | — | — |

The `pgvector` cells are expected to dominate P3 (a managed database instance
is provisioned), and the two clouds differ structurally in P1 and P3 — AWS
replicates into ECR as the tenant role, reached through GitHub OIDC, and applies
once; Azure replicates into ACR between a targeted and a full apply. Stating these expectations
*before* running the campaign, and reporting whether they held, is stronger
methodology than reporting the numbers alone.

### Measured from the run history

`scripts/evaluate-deployment-timings.cjs` archives every deploy and teardown run
GitHub still holds: 105 runs, 143 attempts, June to October 2026. For each it
keeps the jobs and steps, and what the job log said where the log survives
(56 runs): Terraform's plan and the resources it touched, the vector store the
run was given, and the error lines with credentials and account numbers removed.
Runs are joined to the platform's deployments table where a row exists (34
runs). The report is `docs/evaluation/deployment-timing/REPORT.md`; the archive,
`runs.json`, only grows, so what was read from a log outlives GitHub's 90-day
retention.

Three choices keep the numbers honest:

- **Runs of different code are not pooled.** A run's configuration version is
  its workflow file and Terraform root at the commit it ran. The history holds
  44 versions; anything pooled across them is labelled development history.
- **Attempts are counted.** A run re-run from GitHub's interface keeps one id,
  so final outcomes alone report 58 of 105 runs succeeding where 63 of 143
  attempts did.
- **Queue time starts with the attempt.** Measured from the run's creation,
  re-runs show queues of up to 12.8 hours; measured correctly, GitHub's queue is
  a median of 6 s and at most 13 s across all 143 attempts.

Successful runs pooled across versions, as development history (median, with
the interquartile range or, for n = 2, the range):

| Operation | Cell | Succeeded | Run time (min) | Image replication | `terraform apply` |
|---|---|---|---|---:|---:|
| AWS first deploy | A2 pgvector | 10 of 21 runs | 10.3 (9.8–12.0) | 163 s | 442 s |
| AWS first deploy | A1 Pinecone | 2 of 3 | 7.0 (6.9–7.0) | 169 s | 214 s |
| Azure first deploy | B2 pgvector | 2 of 6 | 14.1 (8.5–19.7) | 58 s | 528 s, plus a 90 s wait |
| AWS redeploy | A1, A2 | 7 of 7 | 1.9 (1.7–2.5) | 73 s | 1 s |
| AWS teardown that removed a deployment | A1, A2 | 9 of 9 | 3.1 (0.4–3.3) | — | 158 s |
| Azure teardown that removed a deployment | B2 | 2 of 3 | 14.9 (4.7–25.2) | — | 829 s |

No B1 (Azure with Pinecone) run exists. The expectation stated above held where
there is data: the managed database adds about four minutes to an AWS first
deploy's apply (442 s against 214 s), and Azure's apply is the longest stage of
any cell. A first deploy's time is almost all Terraform; a redeploy's is almost
all image replication. `T5 − T0` and GitHub's run time agree to within seconds:
the platform's record matches GitHub's conclusion in all 34 joined runs, the run
is created about 1 s after Deploy, and the success callback is a step of the job,
so `T5` lands about 2 s before the job ends.

**Repeatability is not established by this history, but where it can be read it
holds.** No version has five successful runs. Where two fresh deploys of one
version both started from nothing, they planned the same resource set: 42
resources twice at `23e1bfc+392f766`, 38 twice at `55143b8+2eade1e` (Pinecone).
Of the four redeploys that ran the same version as the deploy before them,
three planned no change. The fourth updated the docs-signer Lambda in place
(`aws_lambda_function.docs_signer`, at `55143b8+2eade1e`), so that version was
not idempotent; whether the current one is, the campaign below will show. The
other three redeploys followed a code change, so their plans test nothing.

**Teardowns removed less than the deploys created.** In every AWS teardown whose
tenant's deploy log also survived, Terraform destroyed fewer resources than the
deploy had planned to add: 3 of 42 on 31 August, 31–35 of 38–43 on 13 September.
The teardown workflows at those commits run a full `terraform destroy`, with no
`-target` and no `state rm`, so the difference is unexplained until an inventory
is run (E4).

Of the 47 runs that failed, 24 can no longer be classified because their logs
expired. Of the rest: 11 configuration or platform defects, 6 credential or
permission errors, 4 quota or limit errors, 1 account restriction (the AWS
account could not create CloudFront until verified) and 1 cancelled.

The controlled measurement is a **repeatability campaign**: ten redeploys of one
tenant with version, inputs and image held fixed, recorded by
`node scripts/evaluate-deployment-timings.cjs watch`, which archives each run as
it finishes, checks the tenant's input fingerprint and polls `/api/health`
throughout. Protocol and pass criteria: `docs/evaluation/live/RUNBOOK.md`,
*Repeatability campaign*.

### Reliability sub-studies

**Failure taxonomy.** Every non-succeeded run is classified from
`deployments.errorMessage` into: quota/limit, credential/permission, name
collision, provider-transient, platform defect. Report the distribution.
Categories are assigned by the author; the raw messages are tabulated in an
appendix so the classification can be audited.

**Idempotency.** Re-dispatch a deploy against an already-deployed tenant.
Expected: `terraform apply` reports no changes and the run succeeds. This tests
whether the platform is safe to retry — an operational property that the
one-click framing implicitly promises.

**Destroy/onboard cycle.** Run the cell's teardown workflow, then onboard a new
tenant into the same account or subscription. A deleted tenant cannot be
redeployed and its slug is never reused, so the new tenant takes a new slug and
its own setup. Tests that teardown leaves nothing behind that blocks the next
tenant — on Azure, the soft-deleted Key Vault keeps its name reserved, which the
slug rule already makes harmless.

**Webhook-loss recovery (fault injection).** The progress endpoint contains a
self-healing reconciliation path: if GitHub reports the run finished but the
completion callback never arrived, the row is repaired
(`src/app/api/deployments/[id]/progress/route.ts`). Inject the fault by
blocking the final callback, then measure time-to-detection. Constants under
test: `RUN_LOOKUP_GRACE_MS` (60 s) and `STALE_DEPLOYMENT_MS` (75 min: the longest workflow job timeout, 60 min, plus queueing margin).

```
  normal path        │  fault-injected path
  ───────────────────┼──────────────────────────────────────────
  workflow finishes  │  workflow finishes
        │            │        │
        ▼            │        ✗  callback blocked
  POST /status       │        │
        │            │        │  deployment row stuck "running"
        ▼            │        ▼
  row = succeeded    │  operator opens /tenants/{id}
                     │        │
                     │        ▼  GET /api/deployments/{id}/progress
                     │     queries GitHub, sees run completed,
                     │     reconciles row  ──► measure this latency
```

---

## 5. Evaluation Axis 3 — Isolation and Security (C3)

**RQ3.** Are the isolation properties claimed in `ARCHITECTURE.md` and
`SECURITY.md` empirically verifiable?

This is the axis that carries the most weight. `SECURITY.md` already documents
a threat model, a credential inventory and eighteen known limitations. The
evaluation's job is to convert its *claims* into *executable pass/fail tests*.

### Test suite

| ID | Claim under test | Procedure | Pass criterion |
|---|---|---|---|
| **S1** | Cross-tenant retrieval is impossible | Deploy two tenants, each with a corpus containing a unique canary fact. Ask tenant A a question answerable only from B's corpus. Repeat for both vector stores. | A's answer never contains B's canary; `sources` never cite B's keys |
| **S2** | The platform holds no credential able to read a document | With every credential the platform possesses, attempt `s3:GetObject` and `s3:ListBucket` against the tenant docs bucket | Every attempt returns `AccessDenied` |
| **S3** | The docs-signer role is write-only | Inspect the deployed Lambda role; attempt a read through the signer path | Role grants only `PutObject`/`DeleteObject`; read attempts fail |
| **S4** | Platform activity in the customer account is least-privilege | Enumerate all CloudTrail events for the assumed role across one full deploy | Event set ⊆ documented credential inventory in `SECURITY.md` |
| **S5** | The status webhook is unforgeable | Replay a captured callback; forge one with absent/wrong/near-miss secret | All rejected; `timingSafeEqual` used |
| **S6** | Secrets are not recoverable from CI logs | Grep full workflow logs for key material across all 40 runs | No plaintext secret appears |
| **S7** | Encrypted-at-rest claim holds | Inspect `tenants` rows directly in Postgres | No plaintext credential column; format matches `{iv}:{tag}:{ct}` |

**S1 and S2 are the headline results.** S2 in particular is an *executable
proof of an architectural claim*: `ARCHITECTURE.md` asserts the platform holds
no credential capable of reading a document, and S2 either demonstrates that or
falsifies it. Few student projects test their own architecture diagram; doing
so is a genuine methodological contribution.

### S1 topology

```
  ┌─────────────── tenant-alpha ───────────────┐   ┌─────────── tenant-beta ────────────┐
  │  corpus A                                  │   │  corpus B                          │
  │   └── canary: "the alpha access code       │   │   └── canary: "the beta access     │
  │        is QUARTZ-7741"                     │   │        code is CINDER-2208"        │
  │                                            │   │                                    │
  │  vector namespace / index / table          │   │  vector namespace / index / table  │
  └──────────────────┬─────────────────────────┘   └──────────────┬─────────────────────┘
                     │                                            │
   probe ────────────┤                                            │
   "What is the beta access code?"                                │
                     │                                            │
                     ▼                                            │
              expected: refusal or "not in context"               │
              FAIL if the answer contains CINDER-2208 ◄────────────┘
                     │
   probe ────────────┤  control: "What is the alpha access code?"
                     ▼
              expected: QUARTZ-7741   (confirms retrieval works at all,
                                       so a pass is not a false negative)
```

The control probe is essential. Without it, a broken retrieval pipeline would
produce a perfect isolation score.

### Automated scanning

| Tool | Target | Reported |
|---|---|---|
| `npm audit` | platform dependencies | count by severity, before/after remediation |
| `tfsec` or Checkov | both Terraform roots | findings by severity, fixed vs. accepted |
| `npm run test:coverage` | platform test suite | coverage of security-critical modules |

Coverage is reported specifically for the modules on the credential path —
`src/lib/crypto.ts`, `aws.ts`, `azure.ts`, `docsSigner.ts`, `deploy.ts` — each
of which already has a co-located test file. Whole-repo coverage percentage is
a weak metric; coverage of the code that handles secrets is not.

As of 18 October 2026 the configured scope stands at 98.06% of lines and
93.49% of branches (909 tests). It was 91.28% and 89.22% in the 11 October
snapshot in `docs/evaluation/automated`. The gain came from testing what
was previously untested: the tenant-secrets route (0% → 100%) and
`verifyConnection.ts` (16.66% → 100%).

### Attack-matrix unit tests

Instead of adding unrelated tests, each security property already under test
was extended with adversarial variations. All of them run in `npm test`.

| Property | Variations added | Where |
|---|---|---|
| Workflow injection | Command separator, `$( )`, backticks, pipe, line break, carriage return, NUL and oversized values, each appended to an otherwise valid value of every dispatched field, on both clouds | `src/lib/tenantInput.test.ts` |
| GitHub OIDC | Expired and not-yet-valid tokens; lookalike, trailing-slash, `http` and Enterprise-style issuers; prefix-sharing audiences; repository near misses (case, fork, suffix, path); subject near misses (case, suffix, truncation, branch, pull request, fork); wrongly typed claims; two runs racing for one claim | `src/lib/deploymentSecrets.test.ts` |
| Webhooks | Duplicate and concurrent terminal callbacks; ten malformed payloads (array, `null`, form-encoded, `__proto__`, wrong types); every backwards state transition; the secret in the wrong header, case or place | `src/app/api/deployments/[id]/status/route.test.ts` |
| Secret storage | Truncated authentication tags, IVs of other lengths, a fourth blob segment, spliced ciphertexts, a flipped tag bit; key rotation; erasure of every encrypted column, read from the schema so a new one cannot be missed; no OAuth token stored at sign-in | `src/lib/crypto.test.ts`, `src/lib/tenantErasure.test.ts`, `src/auth.test.ts` |
| Proxy perimeter | Paths that only resemble the two unauthenticated callback routes | `src/auth.test.ts` |

Each table was first run against the code as committed. The workflow-injection
table failed 61 of its 142 cases there, and the secret-storage table 7 of 21.
Both led to the fixes listed under *Findings* below.

### Local end-to-end scenarios (SEC-E2E-01 to 04)

Four scenarios follow an attack end to end through the platform's own code
path, stopping only where it would reach a cloud. Each pairs refused attacks
with a control — the same operation by its legitimate owner, which must
succeed — so a system that refused everything would fail. No cloud resource
is created and nothing is sent to GitHub.

| Scenario | Claim | Real application execution | Static policy analysis | Simulated cloud interaction |
|---|---|:---:|:---:|:---:|
| SEC-E2E-01 Cross-tenant authorization | An operator can act on their own tenants only; webhooks change a deployment only forward and only once | ● | | |
| SEC-E2E-02 Document-access denial | Neither the control plane nor the docs-signer can read or list documents | | ● | ○ |
| SEC-E2E-03 Cloud identity isolation | Tenant A's run cannot sign in to, or obtain the secrets of, tenant B | ● | ● | ● |
| SEC-E2E-04 Workflow integrity | Dispatch inputs cannot run commands or rewrite another step's output | ● | | ○ |

● primary method · ○ supporting element. *Real application execution* means
the platform's code runs unmodified: server actions, API routes and SQL against
PostgreSQL (PGlite, migrated with the production migrations), or the committed
workflow scripts in bash with GitHub's flags and `$GITHUB_OUTPUT` semantics.
*Static policy analysis* evaluates the CloudFormation, ARM and Terraform
definitions with the IAM model shared with `scripts/evaluate-security.cjs`
(`scripts/lib/security-model.cjs`). *Simulated cloud interaction* covers STS
and Entra ID decisions, a local key standing in for GitHub's token signer, and
cloud command-line tools replaced by stubs that record their arguments.

Result (18 October 2026): all four pass — 151 of 151 attacks refused, 26 of
26 controls succeeded, 164 tests. The runner searches the evidence for every
fixture secret and eight credential patterns, and withholds and fails any
record that contains one; none did. Figure 5.1
(`docs/figures/thesis/fig-5-1-security-evidence-boundary`) shows the same
method table as a grid.

These are integration and simulation tests, not tests of a live cloud. The
corresponding live evidence is S5 (forged requests to the deployed platform)
and the recorded OIDC deployments.

### Security mutation testing

A passing test shows little unless it would fail if its control were removed.
29 mutants were written by hand, each removing or weakening one control in the
real source, template or workflow: an ownership condition, the one-active
deployment index, a trust condition, an ExternalId, a policy action, a secrets
release check, the workflow guards. A runner applies each mutant, runs the
scenario meant to catch it, and restores the file, which it verifies byte for
byte.

Hand-written rather than generated mutants: a generic tool mutates arithmetic
and literals, and its score would not say whether these claims are tested.

| | Result |
|---|---|
| Mutants that must be killed | **26 / 26 killed** |
| Layered mutants expected to survive | 3 / 3 survived |
| Unexpected outcomes | none |

The three survivors are evidence of defence in depth, not of blind spots. Each
removes one of two independent controls; its paired mutant removes both and
was killed:

| Survives (one layer removed) | Still stopped by | Killed when both are removed |
|---|---|---|
| M08 — webhook's read check for a finished deployment | the conditional UPDATE | M10 |
| M11 — docs-signer URL host check | a URL on record cannot be replaced | M12 |
| M17 — platform may assume any `chatbot-client-*` role | the deployment role trusts GitHub only | M18 |

### Concurrency under real PostgreSQL

PGlite runs one statement at a time on one connection, so the races in
SEC-E2E-01 and 03 interleave between statements but never inside one. They
were repeated against PostgreSQL 16 in a local Docker container through a
connection pool: 25 simultaneous requests per round, 20 rounds, READ COMMITTED.

| Race | Rounds in which the guarantee broke |
|---|---|
| 25 redeploys of one tenant → exactly one deployment | 0 / 20 |
| 25 terminal callbacks → exactly one applied | 0 / 20 |
| 25 secrets claims → released to exactly one run | 0 / 20 |
| 25 cross-tenant redeploys beside the owner's → none succeeds, the owner's does | 0 / 20 |

Two measurements make the result more than an absence of failures:

- **The requests overlapped.** Of 480 losing webhook callbacks, 479 passed the
  route's read check and were refused only by the conditional UPDATE, after
  waiting for the winner's row lock and re-checking its condition. Overlap
  occurred in all 20 rounds.
- **Negative control.** With the unique index dropped, the same redeploy race
  started 25 deployments in every round. The index, not timing, is what
  prevents duplicates.

With zero failures in 20 rounds per race, the 95% upper bound on the per-round
failure rate is about 15% (rule of three: 3/20). The bound is weak because the
number of rounds is small; it tightens with `--rounds`. Each round is itself 25
simultaneous attempts against one guarantee.

### Targeted RAG cross-tenant privacy (SEC-RAG-01)

S1 needs two tenants deployed at once, which the evaluation's free accounts do
not allow, and it sees only what the model chose to say. SEC-RAG-01 runs the
backend image every evaluated tenant ran (`d2885e23`) in local Docker as two
tenants, `acme` and `acme-corp` (one slug extends the other, the hardest case
for anything that scopes by prefix), and checks every question on three
channels: the **answer**, the **sources** it cites, and the **prompt** the
backend sent the LLM. The LLM is a local stub that records each request and
answers by echoing its whole input, so a leak cannot hide behind a model's
discretion. Object storage is a local S3 stub that records which bucket each
tenant's credentials asked for.

Isolation has two layers, and two layouts test them apart. In the platform's
layout each tenant has its own vector store. In the shared layout both tenants
sit in **one pgvector table**, so only the backend's own `WHERE tenant = …`
filter separates them: the defence-in-depth layer, alone.

| | Shared table | Separate databases |
|---|---|---|
| Controls: each tenant retrieves its own canary | 2 / 2 | 2 / 2 |
| Probes: the peer's question, its canary sentence verbatim, `top_k` 10000, the peer's tenant named in the body, a prompt injection, a filter-injection string | 12 / 12 leak nothing | 6 / 6 (first three) |
| A reindex naming the peer's tenant and bucket; one with a prefix that matches nothing; a deleted document's purge | peer's rows unchanged, own bucket only | same |
| Negative control: the same probes against a copy whose query has the filter removed | **leak caught** on every channel | — |

The result is a pass: with both tenants in one table, the tenant filter alone
held against every probe, and the negative control shows the probes would have
seen a leak. Three further results are within one tenant or latent, and are
listed under *Findings*: vector ids that collide across tenants in a shared
store, a caller-chosen reindex prefix that empties the tenant's own index, and
backend images that carry the developer's local environment file.

The test does not exercise Pinecone (cells A1 and B1), and its stand-ins are
local: Postgres in Docker, a stub S3, a stub LLM.

### Findings from these evaluations

| Finding | Found by | Status |
|---|---|---|
| A line break in a tenant field (Azure region, LLM model, chatbot version, S3 prefix) added a line to `$GITHUB_OUTPUT`; in the Azure workflows it overrode `azure_subscription_id`, the subscription the run signs in to and deploys into | Attack matrix (61/142 failed); reproduced against the staged workflow by the SEC-E2E-04 harness | **Fixed** in three places: tenant input validation, a guard step in all four deploy and teardown workflows, and a check in both Azure config parsers. `SECURITY.md` #16 |
| `decryptSecret` accepted an authentication tag truncated to 4 bytes, and ignored a fourth blob segment | Attack matrix (secret storage) | **Fixed**: a full 16-byte tag, a 12-byte IV and exactly three segments are required. `SECURITY.md` #17 |
| The status webhook stores a `chatbotUrl` or `albDnsName` of any scheme and host; reindexing then sends a request there and returns part of the response | Reading the webhook while extending its tests | **Open**. `SECURITY.md` #18 |
| A tenant ID that is not a UUID is refused by a database error rather than as *not found* | SEC-E2E-01 | Open, robustness only: the request is still refused and nothing is touched |
| The backend image ships `/app/.env.local`, holding the developer's Vercel OIDC token (expired 13 September), and `/app/.vercel/`; the platform copies that image into every customer's registry | SEC-RAG-01, image provenance | **Open**: `ai-backend/.dockerignore` excludes `.env` only; the 17 October build carries the same files |
| Vector ids (`<tenant>-<key>-<n>`) collide across tenants whose slugs extend one another, so in a shared store one tenant's reindex takes over the other's chunk | SEC-RAG-01, check I4 | Latent, integrity only: the row moves with its tenant column, and the platform never shares a store (docs-signer keys also start with a UUID) |
| `/api/index` in the evaluated image takes `prefix` from the request body; a prefix that matches nothing purges the tenant's whole index | SEC-RAG-01, check I2 | Within one tenant; fixed in the backend working copy, not in any deployed image |
| `top_k` on `/api/ask` has no upper bound | SEC-RAG-01, probe P3 | Open, within one tenant: one request pulls every chunk that clears the relevance gate into a single prompt |
| AWS teardowns destroyed fewer resources than their deploys had created | Deployment-timing archive (§4) | Open until an E4 inventory explains it |
| A same-version redeploy updated the docs-signer Lambda in place | Deployment-timing archive (§4) | Open: the redeploy campaign tests the current version |

### Reproducing

| Command | Runs | Evidence |
|---|---|---|
| `npm test` | Unit and attack-matrix tests | — |
| `npm run test:coverage` | The same, with coverage | `coverage/` |
| `npm run evaluate:security:e2e` | SEC-E2E-01 to 04 | `docs/evaluation/security-e2e/` |
| `npm run evaluate:security:mutants` | Mutation testing, hand-written mutants (`-- --check` validates every anchor; `-- --generated` runs the generated mutants) | `docs/evaluation/security-mutation/` |
| `npm run evaluate:security:concurrency` | PostgreSQL concurrency; needs Docker (`-- --parallel N --rounds N`) | `docs/evaluation/security-concurrency/` |
| `npm run evaluate:rag-isolation` | SEC-RAG-01; needs Docker and the evaluated backend image (`-- --image <ref>` tests another build) | `docs/evaluation/rag-isolation/` |
| `npm run evaluate:deployments -- extract` then `-- report` | Deployment timings from GitHub's run history; needs `GITHUB_PAT`, and `DATABASE_URL` for the join (`-- watch` records a campaign) | `docs/evaluation/deployment-timing/` |
| `npm run evaluate:reproducibility` | Everything above that needs no credential, in a fresh clone with a stripped environment, compared with the archived evidence | `docs/evaluation/reproducibility/` |
| `node scripts/thesis-figures/fig-5-1-security-evidence-boundary.cjs` | Figure 5.1, from the SEC-E2E results | `docs/figures/thesis/` |

All run locally at no cost; the deployment-timing extraction only reads
GitHub's API. On Windows SEC-E2E-04 takes about four minutes, almost all of it
bash start-up; on Linux it takes seconds.

### Residual risk register

The Known Limitations in `SECURITY.md` are re-presented as a risk table
with likelihood, impact, and disposition (mitigated / accepted / deferred).
Accepted-with-rationale is a legitimate outcome and reads better to an examiner
than a claimed clean bill of health.

Limitation #2 is the worked example of *mitigated*: the operator could once
recover every Azure customer's subscription credential from the database and
`PLATFORM_ENCRYPTION_KEY`. Workload identity federation removed the credential
rather than protecting it better, so the platform now stores no credential to
any customer cloud. Two bounds remain and should be stated rather than buried:
application secrets (LLM, Pinecone, docs-signer) are still recoverable by the
operator, and the trust that the stored secret used to carry now sits with the
deploy repository and GitHub as token issuer (Limitation #8).

A before/after credential inventory makes the change measurable: count, per
cloud, the values the platform holds that grant access to a customer account
(before: AWS 0, Azure 1 per tenant; after: 0 and 0).

The register also carries what the evaluation itself found (see *Findings*
above): two vulnerabilities mitigated during the evaluation (`SECURITY.md` #16
and #17) and one still open (#18). An evaluation that found real defects and
reports one unresolved is more credible than one in which everything passes.

---

## 6. Evaluation Axis 4 — Cost (C2)

**RQ4.** Is the platform's cost estimate accurate, and what does isolation
cost per tenant?

`src/lib/pricing.ts` renders a static list-price estimate at onboarding, from
the Terraform sizing defaults. The platform makes no billing API calls, so the
estimate is unvalidated by construction — which makes validating it a clean,
self-contained result.

### Method

One tenant per cell is left running for 48 hours with no traffic beyond the
health checks, then actual spend is read from AWS Cost Explorer / Azure Cost
Management, normalised to a 30-day month, and compared to the figure the UI
showed at onboarding.

| Cell | Estimated $/mo | Actual (48 h → 30 d) | Error % | Largest contributor |
|---|---|---|---|---|
| A1 | — | — | — | — |
| A2 | — | — | — | — |
| B1 | — | — | — | — |
| B2 | — | — | — | — |

### Secondary analyses

- **Isolation premium.** `pgvector` − `pinecone` per cloud, quantifying the
  cost of keeping embeddings inside the customer account. `ARCHITECTURE.md`
  asserts roughly $14/month (AWS) and $17/month (Azure) for the smallest instance; this validates it.
- **Marginal cost of the *n*-th tenant.** The architecture shares no
  infrastructure between tenants, so cost scales linearly. Report the slope and
  discuss it as the deliberate price of the isolation model — a
  pooled-multi-tenant design would amortise it, at the cost of C3.
- **Idle-cost dominance.** With no traffic, essentially all spend is fixed
  (load balancer, always-on task, database). Note what fraction of an idle
  tenant's bill is structural, since that determines the viability of the model
  for small customers.

---

## 7. Evaluation Axis 5 — Configuration Equivalence (supporting)

**RQ5.** Does the deployed chatbot behave equivalently across the four
configurations?

**Scope boundary.** The RAG backend lives in a separate repository and is
explicitly out of scope (`CHATBOT-LOGIC.md`). This axis therefore does **not**
attempt a RAG-quality study — that would evaluate someone else's artefact.
The question is narrower and squarely about the platform: *does the operator's
choice of cloud or vector store change the answers?*

### Method

A fixed corpus and a golden set of 30–50 question/answer pairs are run
identically against all four cells.

| Metric | A1 | A2 | B1 | B2 |
|---|---|---|---|---|
| Retrieval hit rate @ k | — | — | — | — |
| Answers grounded in retrieved context | — | — | — | — |
| Refusals on unanswerable questions | — | — | — | — |
| `/api/ask` latency p50 | — | — | — | — |
| `/api/ask` latency p95 | — | — | — | — |
| Pairwise answer agreement vs. A1 | n/a | — | — | — |

Grounding is scored by the author against a rubric fixed *before* the runs;
the rubric and the full scored set go in an appendix. Latency is reported
separately from quality because it is a genuine platform property — Pinecone
adds a network hop to a third-party service, pgvector queries a database on the
tenant's own private network.

The interesting result here is the last row. High pairwise agreement supports a
claim the thesis needs: **the abstraction is honest — choosing a cloud or a
vector store is an infrastructure decision, not a behavioural one.** Low
agreement is equally publishable, and more interesting.

---

## 8. Evaluation Axis 6 — Operator Usability (supporting)

**RQ6.** Can a target operator complete tenant onboarding unaided?

The onboarding wizard (`src/app/tenants/new/wizard/`) is the entire operator
surface for the one-click claim, so it warrants direct study.

### Method

Formative usability study, 5–8 participants with cloud/devops familiarity. Task:
onboard and deploy a tenant into a prepared sandbox account, using only the
interface and `CLIENT-DEPLOYMENT-GUIDE.md`. Think-aloud protocol, screen
recording, followed by the **System Usability Scale** (10 items, standard,
citable, comparable to a large published corpus) and a short semi-structured
interview.

Small *n* is appropriate for a formative study whose aim is to surface usability
defects rather than to estimate a population mean; the SUS score is reported
with that caveat and not treated as a precise measurement.

| Measure | Result |
|---|---|
| Task completion rate (unaided) | — |
| Time on task — median | — |
| Errors / wrong turns per participant | — |
| Step at which participants stalled most | — |
| SUS score — mean ± SD | — |

**Ethics.** Participants give informed consent, no personal data beyond a
pseudonymous ID is retained, sandbox credentials are revoked afterwards, and
recordings are destroyed after analysis. State the institution's ethics
position explicitly in the thesis.

The wizard's error-recovery design is worth a targeted observation: it jumps
back to the *earliest step containing a rejected field* rather than reporting an
error where the user cannot see the offending input
(`src/app/tenants/new/wizard/steps.ts`). Whether participants noticed and
benefited from this is a concrete, falsifiable usability question.

---

## 9. Instrumentation Gap — Close This First

The 40-run campaign in EA2 cannot be analysed with the current schema.

**Problem.** `deployments` records only `startedAt` and `finishedAt`
(`src/db/schema.ts:139-140`) — that is `T5 − T0` and nothing else. Per-step
timings exist only transiently: `fetchRunProgress` in `src/lib/github.ts`
queries the GitHub API live, and `/api/deployments/[id]/progress` serves them
only *while the deployment is active*. Once a run completes, the phase
breakdown is no longer collected anywhere.

**Consequence if ignored.** The campaign completes, and every P1–P4 row in §4
is unfillable. GitHub retains run logs for a limited window, so late recovery is
partial at best.

**Fix, in priority order:**

1. **Persist step timings on completion.** On the terminal callback in
   `/api/deployments/[id]/status`, fetch the run's jobs/steps once and archive
   them — either a `deployment_steps` table (`deploymentId`, `jobName`,
   `stepName`, `startedAt`, `completedAt`, `conclusion`) or a `stepTimings`
   JSONB column on `deployments`. A table is preferable for querying the
   campaign later.
2. **Record the cell.** `cloudProvider` and `vectorStore` live on `tenants`, so
   the join exists — but tenants are mutable. Denormalise both onto the
   `deployments` row at dispatch so a run is permanently attributable to its
   cell.
3. **Add an external probe for `T6`/`T7`.** A small script that polls
   `/api/health` and then posts a golden question to `/api/ask`, recording both
   timestamps. This lives in `scripts/` alongside the existing operational
   scripts; it is the only way to measure the honest end-to-end figure.

```
  current                          required for EA2
  ─────────────────────            ──────────────────────────────
  deployments                      deployments
    startedAt   ── T0                startedAt   ── T0
    finishedAt  ── T5                finishedAt  ── T5
                                     cloudProvider  ┐ cell attribution
                                     vectorStore    ┘
                                          │
                                          │ 1:N
                                          ▼
                                   deployment_steps
                                     jobName, stepName
                                     startedAt, completedAt   ── T1..T4
                                     conclusion

  (transient, lost on completion)  scripts/probe-readiness.ts
    GitHub jobs/steps API            healthyAt      ── T6
                                     firstAnswerAt  ── T7
```

Do this before starting the campaign, not after.

**Status (18 October 2026).** Fix 1 is met without a schema change:
`scripts/evaluate-deployment-timings.cjs` archives every run's jobs and steps
from GitHub, which keeps them for as long as the run exists, and reads each log
once before its 90-day retention ends (`watch` does so the moment a campaign run
finishes). Fix 2 is met for every run whose log was read (53 of 105 runs), since
the archive records the vector store the run was given, from its log; for the
rest it falls back to the tenant's current row. Fix 3 is
`node scripts/evaluate-live.cjs readiness`.

---

## 10. Threats to Validity

Stated plainly; an examiner will find these regardless, and pre-empting them is
worth more than a defensive posture.

**Internal.**
- The manual baseline (EA1) is n = 1 per cloud and performed by the platform's
  own author, who knows the target architecture in advance. This *understates*
  manual effort relative to an unfamiliar engineer — the reported effort
  reduction is therefore conservative, which is the safe direction, but the
  measurement is not blind.
- Isolation tests (EA3) demonstrate the absence of specific, enumerated leakage
  paths. They cannot demonstrate the absence of all leakage paths.
- Failure classification (§4) and answer grounding (§7) are scored by the
  author. Rubrics are fixed in advance and raw data is tabulated in appendices,
  but no second rater is available.
- The local security scenarios (§5) simulate cloud decisions. The IAM model
  covers only the policy constructs the templates use, and throws on any other
  rather than skipping it. It does not model SCPs, permission boundaries or
  session policies, and Entra ID's matching is modelled as exact comparison of
  issuer, subject and audience. Mutation testing shows the tests depend on each
  modelled control. It cannot show the model agrees with AWS; validating it
  against `iam:SimulateCustomPolicy` would.
- SEC-E2E-04 runs the workflow scripts in Git Bash on Windows, with cloud CLIs
  stubbed, not on a GitHub-hosted Ubuntu runner. The harness reproduces the
  runner's bash flags and `$GITHUB_OUTPUT` rules and refuses any expression it
  does not model, but a runner-specific difference could escape it.
- The attack cases and the mutants were written by the same author as the code
  they test. Mutation testing bounds this — every listed control is shown to be
  tested — but it cannot reveal a control that is missing from both the code
  and the list. The generated mutants remove the author's choice of mutants,
  not of operators: they only weaken guards, query conditions and validators,
  so a missing check or a wrong constant is outside their reach.
- SEC-RAG-01 runs the deployed backend image against local stand-ins (Postgres
  in Docker, a stub S3, a stub LLM), and separate databases on one server stand
  in for separate database instances. It shows the absence of the leaks it
  probes for, in pgvector only.
- The deployment-timing history is the author's development: tenants were
  created to test changes, so failures concentrate where the code was changing,
  and a version's few runs were often minutes apart on one account. It describes
  what happened, not a sampled population; the campaign is the controlled
  measurement.
- The reproducibility run removes the author's environment, not the machine:
  it reuses the local npm cache (integrity-checked against the lockfile) and
  Docker images from the local cache, pinned by id in its report.

**External.**
- One region per cloud; latency and quota behaviour differ elsewhere.
- List prices, not negotiated or committed-use rates.
- No real customer tenants and no production traffic; all measurements are on
  idle or synthetically probed deployments.
- Usability participants are developers, not necessarily the intended operator
  persona.

**Construct.**
- The RAG backend is treated as a black box by design (`CHATBOT-LOGIC.md`), so
  EA5 measures configuration equivalence, not answer quality. A poor backend
  would score well on equivalence.
- "Effort" is operationalised as time, actions and consoles touched. Cognitive
  load and the effort of *acquiring* the knowledge to deploy manually are not
  captured, and both favour the platform.

**Statistical.**
- n = 10 per cell supports descriptive statistics and obvious effects. Formal
  significance testing between cells is reported only where the effect is large
  relative to variance; cloud-provider queue latency is outside the author's
  control and inflates variance in P1 and P2.
- The concurrency evaluation's zero failures in 20 rounds bound the per-round
  failure rate at about 15% (95%, rule of three), not at zero. The overlap
  measurement and the negative control carry more of the argument than the
  round count.

---

## 11. Figure Plan

Figures the thesis will contain once the campaign has run. Listed here so the
data collection above is known to be sufficient to produce them.

| Fig. | Content | Type | Data source |
|---|---|---|---|
| 1 | Control plane / data plane boundary | architecture diagram | `ARCHITECTURE.md` |
| 2 | Configuration matrix (§2) | 2×2 diagram | design |
| 3 | Deployment timeline `T0`–`T7` with phases | annotated timeline | design |
| 4 | Manual vs. platform effort | grouped bar, by cloud | EA1 |
| 5 | End-to-end deployment time by cell | box plot, n = 10 each | EA2 |
| 6 | Phase breakdown P1–P6 | stacked bar, 4 cells | EA2 + `deployment_steps` |
| 7 | Failure taxonomy | bar or Pareto | EA2 |
| 8 | Webhook-loss detection latency | timeline / CDF | EA2 fault injection |
| 9 | Isolation test topology | diagram | §5 |
| 10 | Security test results S1–S7 | pass/fail matrix | EA3 |
| 11 | Residual risk register | likelihood × impact grid | `SECURITY.md` |
| 12 | Estimated vs. actual cost | paired bar, 4 cells | EA4 |
| 13 | Cost scaling with tenant count | line, linear | EA4 |
| 14 | `/api/ask` latency distribution | box plot, 4 cells | EA5 |
| 15 | SUS score with published-corpus reference bands | bar + reference line | EA6 |
| 16 | Evidence type of the local security scenarios (drawn as Fig. 5.1) | grid: scenario × system part | `docs/evaluation/security-e2e/results.json` |

Figures 5, 6, 10 and 12 are the load-bearing ones — they correspond directly to
C2, C3 and the cost claim.

---

## 12. Prioritisation

If time is constrained, execute in this order.

| Priority | Work | Why |
|---|---|---|
| **0** | Instrumentation (§9) | Blocks EA2 entirely; cheap; must precede the campaign |
| **1** | EA3 isolation and security | Carries C3, the distinguishing claim; S1/S2 are the strongest results available |
| **2** | EA2 deployment campaign | Carries C2; 40 runs is the largest time commitment — start early, it can run in the background |
| **3** | EA1 effort baseline | Carries C1; two long manual sessions, no dependencies |
| **4** | EA4 cost validation | Nearly free once EA2 tenants exist — leave four running for 48 h |
| **5** | EA6 usability | Best value per hour for an empirical human-factors chapter; needs participant scheduling, so start recruiting early even though it executes late |
| **6** | EA5 configuration equivalence | Deliberately bounded; expand only if time permits |

EA4 and EA6 have long lead times relative to their effort — a cost measurement
needs 48 hours of elapsed time, and participants need scheduling. Both should be
*initiated* well before their execution priority suggests.

---

## Related Documents

| Document | Relevance |
|---|---|
| `ARCHITECTURE.md` | System design; the claims EA3 tests |
| `SECURITY.md` | Threat model, credential inventory, eighteen known limitations |
| `DOCS.md` | Reference for routes, schema, workflows, cost model |
| `CHATBOT-LOGIC.md` | Backend scope boundary constraining EA5 |
| `CLIENT-DEPLOYMENT-GUIDE.md` | Operator-facing material used in EA6 |
| `docs/evaluation/security/` | S1–S10 results, scanner output |
| `docs/evaluation/security-e2e/` | SEC-E2E-01 to 04: every attack and control observed |
| `docs/evaluation/security-mutation/` | Mutation testing of the security tests and harness, hand-written and generated |
| `docs/evaluation/security-concurrency/` | Concurrency under real PostgreSQL |
| `docs/evaluation/rag-isolation/` | SEC-RAG-01: cross-tenant retrieval against the deployed backend image |
| `docs/evaluation/deployment-timing/` | Every deploy and teardown run, its stages and plans; repeatability campaigns |
| `docs/evaluation/reproducibility/` | The clean reproducibility run and its comparison with the archive |
