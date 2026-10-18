# Security mutation testing

Hand-written mutants: generated 2026-10-18T05:16:16.407Z by `npm run evaluate:security:mutants` at commit `61de49007640` with uncommitted changes, Node v24.16.0, 5.6 min. Baseline: 1073/1073 tests passed unmutated.

Each mutant removes or weakens one control in the real source, template, workflow or test harness; the tests meant to catch it are then run. **Killed** means at least one test failed. Mutants marked *layered* are expected to survive because a second, independent control still blocks the attack; each is paired with a mutant that removes both layers. Expectations are fixed in the script before the run.

**Mutation score: 45/45** of the mutants that must be killed were killed. Layered mutants that survived as expected: 3/3. Unexpected outcomes: none.

| Class | Killed |
|---|---|
| Controls of the local scenarios | 27/27 |
| Regressions: the vulnerabilities this evaluation found, put back | 6/6 |
| The unit-level attack matrix | 8/8 |
| The harness's own oracles | 4/4 |

## Controls of the local scenarios

One mutant per claim of SEC-E2E-01 to 04.

| ID | Run against | Control removed or weakened | Expected | Outcome | Caught by |
|---|---|---|---|---|---|
| M01 | SEC-E2E-01 | Redeploy checks the tenant's owner | killed | **killed** | 3 test(s), e.g. redeploy |
| M02 | SEC-E2E-01 | Teardown checks the tenant's owner | killed | **killed** | 1 test(s), e.g. teardown |
| M03 | SEC-E2E-01 | Redeploy excludes deleted tenants | killed | **killed** | 1 test(s), e.g. a deleted tenant of Alice's own cannot be acted on |
| M04 | SEC-E2E-01 | Document actions check the tenant's owner | killed | **killed** | 1 test(s), e.g. document actions |
| M05 | SEC-E2E-01 | Upload authorization checks the tenant's owner | killed | **killed** | 2 test(s), e.g. upload authorization |
| M06 | SEC-E2E-01 | Deployment API checks the tenant's owner | killed | **killed** | 1 test(s), e.g. deployment API |
| M07 | SEC-E2E-01 | Database allows one active deployment per tenant | killed | **killed** | 2 test(s), e.g. a double-clicked redeploy starts exactly one deployment |
| M08 | SEC-E2E-01 | Webhook refuses a finished deployment (read check only) | survives (layered) | **survived** | The conditional UPDATE still matches only an active row, so the replay is refused with 409. M10 removes both. |
| M09 | SEC-E2E-01 | Webhook writes only to a still-active row (conditional UPDATE) | killed | **killed** | 1 test(s), e.g. concurrent terminal callbacks: the first to commit stands |
| M10 | SEC-E2E-01 | Webhook: both forward-only checks (M08 + M09) | killed | **killed** | 2 test(s), e.g. a duplicate terminal callback is applied once |
| M11 | SEC-E2E-01 | Docs-signer URL must be this tenant's host (shape check only) | survives (layered) | **survived** | A URL already on record cannot be replaced, so the redirect is still refused. M12 removes both. |
| M12 | SEC-E2E-01 | Docs-signer URL: both checks (M11 + no-replacement) | killed | **killed** | 1 test(s), e.g. refuses a near-miss secret and a docs-signer URL on another host |
| M13 | SEC-E2E-01 | Webhook secret compared in full | killed | **killed** | 1 test(s), e.g. refuses a near-miss secret and a docs-signer URL on another host |
| M14 | SEC-E2E-02 | AWS signer may only write and delete | killed | **killed** | 1 test(s), e.g. AWS: the signer's S3 policy |
| M15 | SEC-E2E-02 | Azure signer role has no blob read | killed | **killed** | 1 test(s), e.g. Azure: the signer's custom role |
| M16 | SEC-E2E-02 | Onboarding role (which the platform assumes) reaches only secrets | killed | **killed** | 2 test(s), e.g. no path to a document runs through OnboardingRole |
| M17 | SEC-E2E-02 | Platform role may assume onboarding roles only | survives (layered) | **survived** | The deployment role trusts GitHub alone, so the wider grant reaches no role that admits the platform. M18 removes both. |
| M18 | SEC-E2E-02, SEC-E2E-03 | Platform role scope and deployment-role trust (M17 + platform trusted) | killed | **killed** | 2 test(s), e.g. no path to a document runs through DeploymentRole |
| M19 | SEC-E2E-03 | Deployment role matches the GitHub subject exactly | killed | **killed** | 2 test(s), e.g. refuses a token from tenant B's environment |
| M20 | SEC-E2E-03 | Onboarding role requires this tenant's ExternalId | killed | **killed** | 4 test(s), e.g. refuses tenant B's ExternalId |
| M21 | SEC-E2E-03 | Azure federated credential names the tenant's environment | killed | **killed** | 2 test(s), e.g. control: the template's credential is the one the platform tells the customer to create, and admits A's run |
| M22 | SEC-E2E-03 | Secrets release checks the token's subject | killed | **killed** | 2 test(s), e.g. refuses B's run, for A's deployment, and leaves the deployment unclaimed |
| M23 | SEC-E2E-03 | Secrets release checks the workflow and ref | killed | **killed** | 2 test(s), e.g. refuses the connection check in A's environment, and leaves the deployment unclaimed |
| M24 | SEC-E2E-03 | Secrets release checks the repository | killed | **killed** | 1 test(s), e.g. refuses a fork's run naming A's environment, and leaves the deployment unclaimed |
| M25 | SEC-E2E-03 | Secrets are released once per deployment | killed | **killed** | 1 test(s), e.g. refuses a second run after the first has claimed, and a replay by the first |
| M26 | SEC-E2E-04 | Deploy refuses inputs containing line breaks | killed | **killed** | 1 test(s), e.g. .github/workflows/deploy-tenant.yml refuses an input with a line break, and passes a clean one |
| M27 | SEC-E2E-04 | Azure config parser refuses line breaks | killed | **killed** | 12 test(s), e.g. with a new line overriding the subscription is refused before any output is written |
| M28 | SEC-E2E-04 | Inputs reach scripts only through env: | killed | **killed** | 2 test(s), e.g. control: a well-formed config flows through both steps |
| M29 | SEC-E2E-04 | Inputs are quoted, never evaluated | killed | **killed** | 7 test(s), e.g. command substitution reaches docker and aws as one argument, never as code |
| M30 | SEC-E2E-04 | AWS teardown refuses inputs containing line breaks | killed | **killed** | 1 test(s), e.g. .github/workflows/destroy-tenant.yml refuses an input with a line break, and passes a clean one |

## Regressions: the vulnerabilities this evaluation found, put back

Each re-introduces a defect from *Findings* (EVALUATION.md §5) in the form it was found. A fix whose tests do not notice it being undone is not locked in.

| ID | Run against | Control removed or weakened | Expected | Outcome | Caught by |
|---|---|---|---|---|---|
| R01 | `tenantInput.test.ts` | #16 Free-text dispatch fields accept any character again (chatbot version, model, Azure region) | killed | **killed** | 40 test(s), e.g. refuses a command separator |
| R02 | `crypto.test.ts` | #17 decryptSecret accepts an authentication tag shorter than 16 bytes | killed | **killed** | 4 test(s), e.g. refuses the real tag truncated to 4 bytes |
| R03 | `crypto.test.ts` | #17 decryptSecret ignores a fourth blob segment | killed | **killed** | 1 test(s), e.g. refuses a blob with a fourth segment rather than ignoring it |
| R04 | `tenantIsolation.test.ts` | S10.5 A connection check may name another operator's tenant | killed | **killed** | 1 test(s), e.g. S10.5 a connection check naming another operator's tenant is refused |
| R05 | SEC-E2E-04 | #16 Azure deploy workflow as found: no line-break guard and no parser check | killed | **killed** | 13 test(s), e.g. with a new line overriding the subscription is refused before any output is written |
| R06 | SEC-E2E-04 | #16 Azure teardown workflow as found: no line-break guard and no parser check | killed | **killed** | 2 test(s), e.g. the teardown's config parser refuses the same line break |

## The unit-level attack matrix

One mutant per row of the attack-matrix table (EVALUATION.md §5) not already covered above, caught — or not — by `npm test`.

| ID | Run against | Control removed or weakened | Expected | Outcome | Caught by |
|---|---|---|---|---|---|
| A01 | `deploymentSecrets.test.ts` | OIDC: the token's audience is checked | killed | **killed** | 4 test(s), e.g. is refused when minted for the audience api://AzureADTokenExchange |
| A02 | `deploymentSecrets.test.ts` | OIDC: the token's issuer is checked | killed | **killed** | 5 test(s), e.g. must come from GitHub's issuer |
| A03 | `deploymentSecrets.test.ts` | OIDC: the claims that identify a run must be strings | killed | **killed** | 2 test(s), e.g. must carry the claims that identify a run |
| A04 | `route.test.ts` | Webhook: no secret configured means no callback is accepted | killed | **killed** | 1 test(s), e.g. rejects when DEPLOY_WEBHOOK_SECRET is not configured, even with a matching header |
| A05 | `route.test.ts` | Webhook: a run can never move a deployment back to pending | killed | **killed** | 1 test(s), e.g. never lets a run move a deployment back to pending |
| A06 | `auth.test.ts` | Proxy: only the two callback routes pass unauthenticated | killed | **killed** | 4 test(s), e.g. does not let /api/deployments/dep-1/status/extra through without a session |
| A07 | `auth.test.ts` | Sign-in stores no GitHub token | killed | **killed** | 1 test(s), e.g. stores no token GitHub hands back |
| A08 | `tenantErasure.test.ts` | Teardown erases every encrypted column | killed | **killed** | 1 test(s), e.g. nulls every encrypted column on the tenants table |

## The harness's own oracles

The test infrastructure is broken rather than the product. If the tests still passed, they would be passing without proving anything: an evaluator that denies everything makes every "no path to a document" test pass, so only the paired controls can catch it.

| ID | Run against | Control removed or weakened | Expected | Outcome | Caught by |
|---|---|---|---|---|---|
| H01 | SEC-E2E-02, SEC-E2E-03 | IAM evaluator applies Condition blocks (ignoring them would admit any ExternalId and subject) | killed | **killed** | 24 test(s), e.g. refuses a token from tenant B's environment |
| H02 | SEC-E2E-02, SEC-E2E-03 | IAM evaluator can answer Allow (one that only denies makes every denial test pass) | killed | **killed** | 7 test(s), e.g. the onboarding role the platform does assume can neither read a secret back nor reach another tenant's |
| H03 | SEC-E2E-03 | Entra matcher can accept a token (one that refuses all makes every refusal test pass) | killed | **killed** | 1 test(s), e.g. control: the template's credential is the one the platform tells the customer to create, and admits A's run |
| H04 | SEC-E2E-04 | Workflow runner executes the committed step script | killed | **killed** | 18 test(s), e.g. control: a well-formed config flows through both steps |

## Generated mutants

Generated 2026-10-18T05:29:31.633Z by `npm run evaluate:security:mutants -- --generated` at commit `61de49007640` with uncommitted changes, 12.9 min. Baseline: 992/992 tests passed unmutated.

Nobody chose these. Every guard (an `if` that returns, throws or redirects), every alternative of such a guard's `||`, every condition of a drizzle `and(...)` and every zod refinement in 19 security-critical files became one mutant (`scripts/lib/generated-mutants.cjs`). Each was run against every unit test and security scenario that imports its file (`vitest related`), stopping at the first failure. A survivor is equivalent, held by another layer, outside the security claims, or a gap in the tests; each is reviewed in `generated-triage.json`.

**Generated mutation score: 153/203** (75%). Survivors: 50 — 50 unreviewed.

| Operator | Mutants | Killed | Survived |
|---|---:|---:|---:|
| guard | 111 | 96 | 15 |
| guard-term | 29 | 20 | 9 |
| conjunct | 34 | 14 | 20 |
| validator | 29 | 23 | 6 |

| File | Mutants | Killed |
|---|---:|---:|
| `src/lib/crypto.ts` | 10 | 8 |
| `src/lib/deploymentSecrets.ts` | 16 | 12 |
| `src/lib/docsSigner.ts` | 20 | 16 |
| `src/lib/awsTrust.ts` | 1 | 0 |
| `src/lib/tenantInput.ts` | 27 | 23 |
| `src/lib/operators.ts` | 4 | 4 |
| `src/lib/reconcile.ts` | 2 | 0 |
| `src/lib/deploy.ts` | 20 | 17 |
| `src/app/api/deployments/[id]/status/route.ts` | 13 | 10 |
| `src/app/api/deployments/[id]/secrets/route.ts` | 2 | 2 |
| `src/app/api/deployments/[id]/progress/route.ts` | 15 | 12 |
| `src/app/tenants/[id]/actions.ts` | 10 | 9 |
| `src/app/tenants/[id]/documents/actions.ts` | 20 | 15 |
| `src/app/tenants/connectionActions.ts` | 6 | 2 |
| `src/app/tenants/new/actions.ts` | 33 | 22 |
| `src/auth.ts` | 4 | 1 |

### Survivors

| ID | Where | Mutation | Verdict | Why |
|---|---|---|---|---|
| G005 | `lib/crypto.ts:37` (decryptSecret) | alternative dropped: !ivHex | **unreviewed** | not yet reviewed |
| G006 | `lib/crypto.ts:37` (decryptSecret) | alternative dropped: !tagHex | **unreviewed** | not yet reviewed |
| G013 | `lib/deploymentSecrets.ts:89` (verifyRunToken) | alternative dropped: typeof repository !== "string" | **unreviewed** | not yet reviewed |
| G021 | `lib/deploymentSecrets.ts:153` ([claimed]) | query condition dropped: eq(deployments.id, deploymentId) | **unreviewed** | not yet reviewed |
| G023 | `lib/deploymentSecrets.ts:153` ([claimed]) | query condition dropped: inArray(deployments.status, [...ACTIVE_STATUSES]) | **unreviewed** | not yet reviewed |
| G024 | `lib/deploymentSecrets.ts:153` ([claimed]) | query condition dropped: or(isNull(deployments.githubRunId), eq(deployments.githubRunId, claims.run_id)) | **unreviewed** | not yet reviewed |
| G029 | `lib/docsSigner.ts:35` (docsSignerUrlProblem) | alternative dropped: parsed.username | **unreviewed** | not yet reviewed |
| G030 | `lib/docsSigner.ts:35` (docsSignerUrlProblem) | alternative dropped: parsed.password | **unreviewed** | not yet reviewed |
| G033 | `lib/docsSigner.ts:35` (docsSignerUrlProblem) | alternative dropped: parsed.hash | **unreviewed** | not yet reviewed |
| G035 | `lib/docsSigner.ts:44` (docsSignerUrlProblem) | guard removed: if (!tenant.awsRegion) | **unreviewed** | not yet reviewed |
| G047 | `lib/awsTrust.ts:91` (awsOnboardingRoleArn) | guard removed: if (!match) | **unreviewed** | not yet reviewed |
| G049 | `lib/tenantInput.ts:37` (name) | validation dropped: .max(100) | **unreviewed** | not yet reviewed |
| G050 | `lib/tenantInput.ts:37` (name) | validation dropped: .min(1, "Required") | **unreviewed** | not yet reviewed |
| G061 | `lib/tenantInput.ts:91` (deploymentRoleArn) | validation dropped: .refine((v) => v.includes(`:role/${AWS_DEPLOY_ROLE_PREFIX}`), `The r) | **unreviewed** | not yet reviewed |
| G068 | `lib/tenantInput.ts:139` (azureRegion) | validation dropped: .min(1, "Required") | **unreviewed** | not yet reviewed |
| G079 | `lib/reconcile.ts:60` ([updated]) | query condition dropped: eq(deployments.id, id) | **unreviewed** | not yet reviewed |
| G080 | `lib/reconcile.ts:60` ([updated]) | query condition dropped: inArray(deployments.status, [...ACTIVE_STATUSES]) | **unreviewed** | not yet reviewed |
| G091 | `lib/deploy.ts:201` (triggerTenantDestroy) | guard removed: if (!tenant) | **unreviewed** | not yet reviewed |
| G094 | `lib/deploy.ts:338` (retrievalMinScore) | alternative dropped: raw === undefined | **unreviewed** | not yet reviewed |
| G095 | `lib/deploy.ts:338` (retrievalMinScore) | alternative dropped: raw === null | **unreviewed** | not yet reviewed |
| G102 | `app/api/deployments/[id]/status/route.ts:19` (chatbotUrl) | validation dropped: .url() | **unreviewed** | not yet reviewed |
| G103 | `app/api/deployments/[id]/status/route.ts:20` (docsSignerUrl) | validation dropped: .url() | **unreviewed** | not yet reviewed |
| G111 | `app/api/deployments/[id]/status/route.ts:109` ([updated]) | query condition dropped: eq(deployments.id, id) | **unreviewed** | not yet reviewed |
| G120 | `app/api/deployments/[id]/progress/route.ts:85` (failStuckDeployment) | query condition dropped: eq(deployments.id, id) | **unreviewed** | not yet reviewed |
| G121 | `app/api/deployments/[id]/progress/route.ts:85` (failStuckDeployment) | query condition dropped: inArray(deployments.status, [...ACTIVE_STATUSES]) | **unreviewed** | not yet reviewed |
| G126 | `app/api/deployments/[id]/progress/route.ts:116` (GET) | guard removed: if (!isActive) | **unreviewed** | not yet reviewed |
| G139 | `app/tenants/[id]/actions.ts:58` ([tenant]) | query condition dropped: isNull(tenants.deletedAt) | **unreviewed** | not yet reviewed |
| G144 | `app/tenants/[id]/documents/actions.ts:22` ([tenant]) | query condition dropped: isNull(tenants.deletedAt) | **unreviewed** | not yet reviewed |
| G150 | `app/tenants/[id]/documents/actions.ts:75` (describePresignFailure) | guard removed: if (err instanceof Error && (err.name === "TimeoutError" \|\| err.name === "AbortError")) | **unreviewed** | not yet reviewed |
| G151 | `app/tenants/[id]/documents/actions.ts:79` (describePresignFailure) | guard removed: if (err instanceof Error && err.message.includes("deploy has not completed")) | **unreviewed** | not yet reviewed |
| G159 | `app/tenants/[id]/documents/actions.ts:201` (abandonUpload) | query condition dropped: eq(tenantDocuments.id, doc.id) | **unreviewed** | not yet reviewed |
| G160 | `app/tenants/[id]/documents/actions.ts:201` (abandonUpload) | query condition dropped: eq(tenantDocuments.status, "pending") | **unreviewed** | not yet reviewed |
| G161 | `app/tenants/connectionActions.ts:72` (readTarget) | guard removed: if (missing.length > 0) | **unreviewed** | not yet reviewed |
| G163 | `app/tenants/connectionActions.ts:110` (startCheck) | guard removed: if ("missing" in target) | **unreviewed** | not yet reviewed |
| G165 | `app/tenants/connectionActions.ts:156` (pollCheck) | guard removed: if (!session?.user?.id) | **unreviewed** | not yet reviewed |
| G166 | `app/tenants/connectionActions.ts:159` (pollCheck) | guard removed: if (Number.isNaN(startedAt.getTime())) | **unreviewed** | not yet reviewed |
| G174 | `app/tenants/new/actions.ts:85` (describeProvisioningFailure) | alternative dropped: constraint.includes("pkey") | **unreviewed** | not yet reviewed |
| G177 | `app/tenants/new/actions.ts:122` (others) | query condition dropped: eq(tenants.cloudProvider, "azure") | **unreviewed** | not yet reviewed |
| G178 | `app/tenants/new/actions.ts:122` (others) | query condition dropped: isNull(tenants.deletedAt) | **unreviewed** | not yet reviewed |
| G183 | `app/tenants/new/actions.ts:154` (checkSlugAvailable) | guard removed: if (!value) | **unreviewed** | not yet reviewed |
| G186 | `app/tenants/new/actions.ts:201` (checkDeploymentIdentity) | guard removed: if (!value.trim()) | **unreviewed** | not yet reviewed |
| G191 | `app/tenants/new/actions.ts:385` (createTenantAndDeploy) | query condition dropped: eq(tenantDrafts.id, draftId) | **unreviewed** | not yet reviewed |
| G192 | `app/tenants/new/actions.ts:385` (createTenantAndDeploy) | query condition dropped: eq(tenantDrafts.ownerUserId, session.user.id) | **unreviewed** | not yet reviewed |
| G194 | `app/tenants/new/actions.ts:451` ([updated]) | query condition dropped: eq(tenantDrafts.id, existingId) | **unreviewed** | not yet reviewed |
| G195 | `app/tenants/new/actions.ts:451` ([updated]) | query condition dropped: eq(tenantDrafts.ownerUserId, session.user.id) | **unreviewed** | not yet reviewed |
| G198 | `app/tenants/new/actions.ts:478` (deleteTenantDraft) | query condition dropped: eq(tenantDrafts.id, draftId) | **unreviewed** | not yet reviewed |
| G199 | `app/tenants/new/actions.ts:478` (deleteTenantDraft) | query condition dropped: eq(tenantDrafts.ownerUserId, session.user.id) | **unreviewed** | not yet reviewed |
| G201 | `auth.ts:113` ((module)) | guard removed: if (!process.env.DATABASE_URL && process.env.NODE_ENV === "production" && process.env.NEXT_PHASE !== "phase-production-build") | **unreviewed** | not yet reviewed |
| G202 | `auth.ts:125` ((module)) | guard removed: if (!configuredAuthSecret && process.env.NODE_ENV === "production" && process.env.NEXT_PHASE !== "phase-production-build") | **unreviewed** | not yet reviewed |
| G203 | `auth.ts:137` ((module)) | guard removed: if (providers.length === 0 && process.env.NODE_ENV === "production" && process.env.NEXT_PHASE !== "phase-production-build") | **unreviewed** | not yet reviewed |
