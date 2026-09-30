# Evaluation Methodology

> **Status: plan, not results.** This document defines *how* the platform is to
> be evaluated and *what* will be measured. Every numeric cell in the tables
> below is a placeholder (`—`) until the corresponding experiment has been run.
> No figure in this document contains measured data yet.

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
a threat model, a credential inventory and six known limitations. The
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
  asserts roughly $16–17/month for the smallest instance; this validates it.
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
| `SECURITY.md` | Threat model, credential inventory, six known limitations |
| `DOCS.md` | Reference for routes, schema, workflows, cost model |
| `CHATBOT-LOGIC.md` | Backend scope boundary constraining EA5 |
| `CLIENT-DEPLOYMENT-GUIDE.md` | Operator-facing material used in EA6 |
