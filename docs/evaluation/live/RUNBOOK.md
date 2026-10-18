# Live evaluation runbook

One session, about two hours with the chatbots running. It covers the evidence-matrix rows
E1, E3, E4, E7–E10, S1 and S4 (`EVALUATION.md` §1.1). Every command is read-only and free.
The deploys, the uploads and the teardowns are the only steps that cost money or need the
platform UI.

`<aws>` is the new AWS tenant's slug. `<azure>` is the Azure tenant's slug: hr-chatbot-1 if it is
still running, otherwise a fresh one. `<profile>` is an AWS CLI profile for the customer
account. `.env` sets `AWS_PROFILE=platform-control-plane`, so pass `--profile` every time.

## Before you start (no cost)

1. Commit, then deploy the platform to Vercel so the live copy carries the S10.5 fix.
2. Sign in to both clouds: `aws login --profile <profile>` (or `aws configure sso`), then
   `az login` and `az account set --subscription <student subscription>`.
3. Write down the backend image digest the deploy will pull. The `/api/index` prefix fix in
   `ai-backend` is still uncommitted, and results describe whatever image is deployed.
4. Check the OpenRouter quota. A free model allows about 50 requests a day on an account with
   less than $10 of credit. The session asks at most about 50 questions, and fewer in practice,
   because questions that retrieve nothing never reach the LLM. A request the quota refuses is
   recorded as ERROR, not as a wrong answer.

## The session

| # | Do | Command | Row |
|---|---|---|---|
| 1 | Launch the customer bootstrap and fill in the wizard up to the Deploy button. Then start this, and press Deploy right after it | `node scripts/evaluate-live.cjs readiness --tenant <aws>` | E1 |
| 1b | In a second terminal, do the same for the Azure tenant (skip it if `<azure>` is already running). Both deploys can run at the same time. | `node scripts/evaluate-live.cjs readiness --tenant <azure>` | E1 |
| 2 | Once each chatbot is healthy, upload the six files in `corpus/fixtures/` to it, plus `canary-alpha.txt` to `<aws>` and `canary-beta.txt` to `<azure>`. Each readiness command finishes on its own once its first correct answer comes back. | — | E1 |
| 3 | Golden set: 19 questions | `node scripts/evaluate-live.cjs qa --tenant <aws>` | E7 E8 E9 |
| 4 | Before uploading the lifecycle canary | `node scripts/evaluate-live.cjs lifecycle --tenant <aws> --stage before` | E10 |
| 5 | Upload `corpus/canaries/canary-lifecycle.txt`, then | `node scripts/evaluate-live.cjs lifecycle --tenant <aws> --stage uploaded` | E10 |
| 6 | Delete that document in the UI, then | `node scripts/evaluate-live.cjs lifecycle --tenant <aws> --stage deleted` | E10 |
| 7 | Cross-tenant test (each tenant holds only its own canary from step 2) | `node scripts/evaluate-live.cjs isolation --a <aws> --b <azure>` | S1 |
| 8 | Press Redeploy on the AWS tenant and wait for it to succeed, then | `node scripts/evaluate-live.cjs idempotency --tenant <aws>` | E3 |
| 9 | Delete the AWS tenant (and `<azure>` if you are done with it). After each teardown succeeds: | `node scripts/evaluate-live.cjs inventory --tenant <aws> --profile <profile>` and `... inventory --tenant <azure>` | E4 |

The chatbots can be stopped after step 9. The rest needs no running service:

| # | Do | Command | Row |
|---|---|---|---|
| 10 | At least 15 minutes after the redeploy (CloudTrail delivers late) | `node scripts/evaluate-live.cjs cloudtrail --tenant <aws> --profile <profile>` | S4 |
| 11 | Build the live report | `node scripts/evaluate-live.cjs report` | all |
| 12 | Fold S1 and S4 into the security report | `node scripts/evaluate-security.cjs --target https://ai-chatbot-platform-gamma.vercel.app` | S1 S4 |
| 13 | Score faithfulness and the three adversarial answers by hand, using the rubric in `qa-<aws>.json` | — | E8 E9 |

## Repeatability campaign (E2, E3)

The historical runs (`docs/evaluation/deployment-timing/REPORT.md`) span 44 configuration
versions, and no version has five successful runs, so they describe development, not
repeatability. A campaign holds everything fixed and repeats one operation. The watcher
archives each run the moment it finishes, records the tenant's input fingerprint, and polls
`/api/health` throughout, so it also shows whether a redeploy interrupts the chatbot.

Pass criteria, fixed before the first run: every run succeeds; every Terraform plan is
`0 to add, 0 to change, 0 to destroy` (E3); one configuration version, one input fingerprint and
one image digest across the campaign; the chatbot answers `/api/health` throughout. Report the
median, interquartile range and coefficient of variation of the run time.

**Cohort R: ten redeploys of one tenant.** Nearly free: GitHub Actions minutes cost nothing on a
public repository, and an idempotent redeploy creates no cloud resource. Use the tenant left
running by the session above (or hr-chatbot-1).

| # | Do | Command |
|---|---|---|
| 1 | Do not push to the deploy branch or edit the tenant until the campaign ends | — |
| 2 | Start the watcher | `node scripts/evaluate-deployment-timings.cjs watch --tenant <slug> --runs 10` |
| 3 | Press Redeploy; press it again each time the watcher says so | — |
| 4 | Build the report | `node scripts/evaluate-deployment-timings.cjs report` |

**Cohort F: fresh deploy and teardown, three cycles of one cell.** Costs cloud credit: each
cycle keeps a full deployment alive for about 25 minutes (AWS pgvector: about 10 minutes to
deploy, 3 to 13 to tear down). Slugs are never reused, so each cycle onboards a new tenant
with otherwise identical inputs; compare the planned resource counts (they should be equal)
and run `inventory` after each teardown (E4). Three cycles bound nothing statistically (3/3
successes leave a 95% upper bound of about 63% on the failure rate); they show the operation
repeats, not how reliably. Run it only if the credit is there.

## Operator log (fill in during the session)

No script can see what the operator does, so the manual-actions measure for E1 is recorded
here by hand. Count one action per click on Deploy, upload or delete, per form field typed,
and per command run in a cloud console. Copy the times from the clock, not from memory.

| # | Action | Where | Started | Finished | Fields typed | Notes (errors, backtracks) |
|---|---|---|---|---|---|---|
| 1 | Launch the bootstrap template | customer cloud console | | | | |
| 2 | Fill in the wizard | platform | | | | |
| 3 | Press Deploy | platform | | | — | |
| 4 | Upload the corpus | platform | | | — | |

The headline deployment time is `T6 − T0`: from the Deploy click to a healthy chatbot. The
`readiness` command reports it, together with each stage's share of the run.

## If something goes wrong

- A command refuses to start because a document is missing or present: it checks the
  platform's records before asking anything, so fix the upload and run it again.
- `lifecycle --stage uploaded` or `--stage deleted` retries for about four minutes while the
  reindex runs. If it still reports the wrong state, run it again once. A second failure is
  a result, not a glitch.
- A deploy fails: the readiness file records FAIL with the reason. Do not delete it. A failed
  attempt is part of E1's evidence.
- Optional, if quota and time allow: `qa --tenant <azure>` after uploading the fixtures there
  as well. That compares the two clouds on the same questions (EA5).
