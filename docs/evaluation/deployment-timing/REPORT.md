# Deployment timings and repeatability

Generated 2026-10-18T05:19:49.357Z by `node scripts/evaluate-deployment-timings.cjs report` from 105 workflow runs archived 2026-10-18T05:19:48.959Z (`runs.json`), joined to the platform's deployments table. Every number is from a run that happened; nothing was dispatched for this report.

## Data

| | Runs |
|---|---:|
| `deploy-tenant.yml` | 63 |
| `deploy-tenant-azure.yml` | 29 |
| `destroy-tenant.yml` | 10 |
| `destroy-tenant-azure.yml` | 3 |
| with the platform's record (T0, T5) | 34 |
| with the job log read (plan counts, vector store, errors) | 56 |
| distinct configuration versions | 44 |

A run's **configuration version** is its workflow file and Terraform root at the commit it ran, hashed from this repository's history and written `<workflow blob>+<Terraform tree>`; it is not a commit id (`runs.json` has each run's commit). Durations are in minutes, given as median (interquartile range); min–max. **Run** is GitHub's first step to last job completed; **queue** is the run being created to its first step; **platform** is `T5 − T0` in the deployments table, Deploy pressed to the final callback. Success rates carry a Wilson 95% interval.

## 1. All runs, pooled across versions

Development history: these runs span changing workflows and Terraform, so the spread includes code changes, and the success rate describes the development period, not the final system. A run re-run from GitHub's interface keeps one id; **runs** counts its final outcome, **attempts** counts every try. The vector store is the one the run was given (read from its log) or, failing that, the tenant's current one; *mode* is from the platform's record, or inferred from Terraform's first plan where there is none.

| Workflow, mode and vector store | Runs | Versions | Runs succeeded | Attempts succeeded | Run (successful) | Queue | Platform T5−T0 (successful) |
|---|---:|---:|---|---|---|---|---|
| AWS first deploy (inferred) · pgvector | 10 | 5 | 6/10 (60%; 95% CI 31%–83%) | 6/12 (50%; 95% CI 25%–75%) | 10.0 (9.8–11.5); 8.2–12.7 | 6 s (6–8); 5–8 s | — |
| AWS first deploy (inferred) · pinecone | 1 | 1 | 0/1 (0%; 95% CI 0%–79%) | 0/1 (0%; 95% CI 0%–79%) | — | 6 s (6–6); 6–6 s | — |
| AWS first deploy · pgvector | 11 | 8 | 4/11 (36%; 95% CI 15%–65%) | 4/11 (36%; 95% CI 15%–65%) | 11.2 (10.1–12.0); 8.9–12.0 | 6 s (6–7); 5–7 s | 11.3 (10.2–12.0); 9.0–12.1 |
| AWS first deploy · pinecone | 2 | 1 | 2/2 (100%; 95% CI 34%–100%) | 2/2 (100%; 95% CI 34%–100%) | 7.0 (7.0–7.0); 6.9–7.0 | 7 s (6–7); 6–7 s | 7.1 (7.0–7.1); 7.0–7.2 |
| AWS redeploy (inferred) · pgvector | 2 | 1 | 2/2 (100%; 95% CI 34%–100%) | 2/2 (100%; 95% CI 34%–100%) | 1.8 (1.7–1.8); 1.6–1.9 | 6 s (6–6); 6–6 s | — |
| AWS redeploy · pgvector | 3 | 3 | 3/3 (100%; 95% CI 44%–100%) | 3/3 (100%; 95% CI 44%–100%) | 1.8 (1.7–2.1); 1.7–2.3 | 6 s (6–7); 5–8 s | 2.0 (1.9–2.2); 1.8–2.5 |
| AWS redeploy · pinecone | 2 | 2 | 2/2 (100%; 95% CI 34%–100%) | 2/2 (100%; 95% CI 34%–100%) | 3.0 (2.8–3.2); 2.6–3.3 | 6 s (5–6); 5–6 s | 3.0 (2.9–3.2); 2.7–3.4 |
| AWS teardown (nothing to destroy) · pgvector | 1 | 1 | 1/1 (100%; 95% CI 21%–100%) | 1/1 (100%; 95% CI 21%–100%) | 0.5 (0.5–0.5); 0.5–0.5 | 5 s (5–5); 5–5 s | 0.6 (0.6–0.6); 0.6–0.6 |
| AWS teardown · pgvector | 6 | 3 | 6/6 (100%; 95% CI 61%–100%) | 6/9 (67%; 95% CI 35%–88%) | 1.8 (0.4–3.2); 0.3–12.8 | 6 s (6–7); 5–8 s | 3.3 (3.2–8.1); 3.1–13.0 |
| AWS teardown · pinecone | 3 | 1 | 3/3 (100%; 95% CI 44%–100%) | 3/3 (100%; 95% CI 44%–100%) | 3.3 (3.2–4.2); 3.1–5.1 | 6 s (6–7); 5–7 s | 3.4 (3.3–4.3); 3.2–5.2 |
| AWS unknown · pgvector | 3 | 2 | 1/3 (33%; 95% CI 6%–79%) | 1/3 (33%; 95% CI 6%–79%) | 1.6 (1.6–1.6); 1.6–1.6 | 6 s (6–7); 5–7 s | — |
| AWS unknown | 29 | 13 | 20/29 (69%; 95% CI 51%–83%) | 24/51 (47%; 95% CI 34%–60%) | 5.7 (4.7–6.2); 1.4–8.0 | 6 s (5–7); 5–13 s | — |
| AZURE first deploy · pgvector | 6 | 4 | 2/6 (33%; 95% CI 10%–70%) | 2/6 (33%; 95% CI 10%–70%) | 14.1 (11.3–16.9); 8.5–19.7 | 6 s (6–8); 5–8 s | 14.2 (11.4–17.0); 8.7–19.8 |
| AZURE teardown · pgvector | 3 | 1 | 2/3 (67%; 95% CI 21%–94%) | 2/3 (67%; 95% CI 21%–94%) | 14.9 (9.8–20.0); 4.7–25.2 | 6 s (6–6); 5–6 s | 15.0 (9.9–20.2); 4.7–25.3 |
| AZURE unknown | 23 | 9 | 4/23 (17%; 95% CI 7%–37%) | 5/34 (15%; 95% CI 6%–30%) | 4.7 (3.0–6.4); 2.5–6.5 | 6 s (5–7); 5–10 s | — |

## 2. Where the time goes

Median seconds per stage over successful runs, per workflow and mode. Terraform's apply step is split at its "Plan:" line into planning and provisioning when the log was read; otherwise all of it counts as provisioning.

| Workflow and mode | n | queue | workflow setup | images | cloud sign-in | terraform init | terraform plan | terraform apply | propagation wait | post-apply |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| AWS first deploy (inferred) · pgvector | 6 | 7 | 6 | 163 | 0 | 7 | 5 | 403 | 0 | 10 |
| AWS first deploy · pgvector | 4 | 6 | 5 | 136 | 2 | 6 | 5 | 492 | 0 | 10 |
| AWS first deploy · pinecone | 2 | 7 | 7 | 169 | 1 | 8 | 5 | 214 | 0 | 15 |
| AWS redeploy (inferred) · pgvector | 2 | 6 | 6 | 70 | 0 | 9 | 13 | 0 | 0 | 8 |
| AWS redeploy · pgvector | 3 | 6 | 6 | 73 | 1 | 7 | 7 | 1 | 0 | 11 |
| AWS redeploy · pinecone | 2 | 6 | 8 | 137 | 1 | 6 | 7 | 8 | 0 | 12 |
| AWS teardown (nothing to destroy) · pgvector | 1 | 5 | 14 | 0 | 1 | 10 | 0 | 3 | 0 | 0 |
| AWS teardown · pgvector | 6 | 6 | 9 | 0 | 1 | 7 | 7 | 78 | 0 | 0 |
| AWS teardown · pinecone | 3 | 6 | 14 | 0 | 1 | 7 | 8 | 160 | 0 | 0 |
| AWS unknown · pgvector | 1 | 5 | 4 | 72 | 1 | 5 | 5 | 2 | 0 | 2 |
| AWS unknown | 20 | 6 | 119 | 0 | 1 | 5 | 0 | 207 | 0 | 2 |
| AZURE first deploy · pgvector | 2 | 7 | 21 | 58 | 4 | 14 | 56 | 528 | 90 | 78 |
| AZURE teardown · pgvector | 2 | 6 | 4 | 0 | 7 | 13 | 41 | 829 | 0 | 1 |
| AZURE unknown | 4 | 7 | 146 | 0 | 6 | 3 | 0 | 135 | 0 | 2 |

## 3. Repeatability: runs of one configuration version

Only runs that ran identical code are compared: same cloud, mode, vector store and configuration version, with at least two runs. The coefficient of variation (CV, SD ÷ mean) of successful run times is the repeatability measure. *Resources planned* lists each distinct plan (add/change/destroy) among the successful runs: one value means the same code created the same resource set, and a smaller add count marks a retry that found part of a deployment already there. Whether these runs were also given identical inputs cannot be told after the fact, since tenant rows are mutable; the campaign in §5 records that.

| Cloud | Mode | Vector store | Version | Runs | Succeeded | Run (successful) | CV | Tenants | Resources planned (successful) | Distinct resource sets | Image digests |
|---|---|---|---|---:|---|---|---:|---:|---|---:|---:|
| aws | first deploy (inferred) | pgvector | `23e1bfc+fd97da4` | 4 | 3/4 (75%; 95% CI 30%–95%) | 10.1 (9.2–11.1); 8.2–12.0 | 0.19 | 4 | +20/~0/−0, +42/~0/−0 | 2 | 4 |
| aws | redeploy (inferred) | pgvector | `23e1bfc+fd97da4` | 2 | 2/2 (100%; 95% CI 34%–100%) | 1.8 (1.7–1.8); 1.6–1.9 | 0.11 | 1 | +0/~0/−0 | — | 3 |
| aws | first deploy (inferred) | pgvector | `23e1bfc+392f766` | 2 | 2/2 (100%; 95% CI 34%–100%) | 9.8 (9.8–9.8); 9.8–9.8 | 0.00 | 2 | +42/~0/−0 | 1 | 2 |
| aws | first deploy | pinecone | `55143b8+2eade1e` | 2 | 2/2 (100%; 95% CI 34%–100%) | 7.0 (7.0–7.0); 6.9–7.0 | 0.01 | 2 | +38/~0/−0 | 1 | 2 |
| azure | first deploy | pgvector | `b014981+b5d756b` | 3 | 1/3 (33%; 95% CI 6%–79%) | 19.7 (19.7–19.7); 19.7–19.7 | — | 2 | +0/~0/−0 then +2/~0/−0 | 1 | 2 |
| aws | first deploy (inferred) | pgvector | `c00f8db+b9a70c1` | 2 | 1/2 (50%; 95% CI 9%–91%) | 12.7 (12.7–12.7); 12.7–12.7 | — | 2 | +34/~0/−0 | 1 | 2 |
| aws | first deploy | pgvector | `2f8fc9c+0b9065e` | 2 | 1/2 (50%; 95% CI 9%–91%) | 12.0 (12.0–12.0); 12.0–12.0 | — | 2 | +45/~0/−0 | 1 | 2 |
| aws | first deploy | pgvector | `2f8fc9c+0566d14` | 2 | 0/2 (0%; 95% CI 0%–66%) | — | — | 1 | — | — | 2 |
| aws | first deploy | pgvector | `ee2facd+7eb3ee9` | 2 | 0/2 (0%; 95% CI 0%–66%) | — | — | 1 | — | — | 2 |
| aws | unknown | ? | `4157f7a+cfd9f3f` | 4 | 4/4 (100%; 95% CI 51%–100%) | 5.2 (4.0–5.7); 1.4–6.0 | 0.46 | 1 | — | — | — |
| azure | unknown | ? | `93c1957+4017b2b` | 6 | 3/6 (50%; 95% CI 19%–81%) | 6.3 (4.4–6.4); 2.5–6.5 | 0.45 | 1 | — | — | — |
| aws | unknown | ? | `b1416db+3223ce5` | 3 | 3/3 (100%; 95% CI 44%–100%) | 2.0 (1.7–3.5); 1.4–5.0 | 0.69 | 1 | — | — | — |
| aws | unknown | ? | `8aee30e+b1aa1fd` | 4 | 2/4 (50%; 95% CI 15%–85%) | 5.4 (5.2–5.6); 5.0–5.8 | 0.11 | 1 | — | — | — |
| aws | unknown | ? | `b1416db+abae2e7` | 3 | 2/3 (67%; 95% CI 21%–94%) | 6.0 (6.0–6.1); 5.9–6.2 | 0.04 | 1 | — | — | — |
| aws | unknown | ? | `8aee30e+e6e14a0` | 2 | 2/2 (100%; 95% CI 34%–100%) | 6.7 (6.5–7.0); 6.2–7.3 | 0.12 | 1 | — | — | — |
| aws | unknown | ? | `4157f7a+b8e36d2` | 2 | 2/2 (100%; 95% CI 34%–100%) | 5.5 (5.2–5.9); 4.8–6.3 | 0.20 | 1 | — | — | — |
| aws | unknown | ? | `d592e18+99e9f18` | 2 | 2/2 (100%; 95% CI 34%–100%) | 6.3 (5.4–7.1); 4.6–8.0 | 0.38 | 1 | — | — | — |
| aws | unknown | pgvector | `c00f8db+b9a70c1` | 2 | 1/2 (50%; 95% CI 9%–91%) | 1.6 (1.6–1.6); 1.6–1.6 | — | 1 | +6/~0/−1 | 1 | 2 |
| azure | unknown | ? | `897b62d+9152cef` | 5 | 0/5 (0%; 95% CI 0%–43%) | — | — | 1 | — | — | — |
| azure | unknown | ? | `897b62d+48128ce` | 5 | 0/5 (0%; 95% CI 0%–43%) | — | — | 1 | — | — | — |
| aws | unknown | ? | `5f7e130+b9a70c1` | 3 | 0/3 (0%; 95% CI 0%–56%) | — | — | 2 | — | — | 2 |
| aws | unknown | ? | `f8dbbe8+3223ce5` | 2 | 0/2 (0%; 95% CI 0%–66%) | — | — | 1 | — | — | — |
| azure | unknown | ? | `897b62d+15f2a86` | 2 | 0/2 (0%; 95% CI 0%–66%) | — | — | 1 | — | — | — |

**No configuration version has five or more successful runs, so no repeatability figure here is more than anecdotal.** The redeploy campaign (§5) is how to obtain one.

## 4. What a redeploy changes, and what a teardown removes

Terraform's plan in every redeploy whose log was read (7 runs). An idempotent redeploy plans no change.

| Run | Cloud | Tenant | Version | Same version as the deploy before it | Plans (add/change/destroy) | No change | What the plan touched | Succeeded |
|---|---|---|---|---|---|---|---|---|
| [33317063872](https://github.com/kaltrinaT/ai-chatbot-platform/actions/runs/33317063872) | aws | test341 | `23e1bfc+fd97da4` | yes | 0/0/0 | yes | — | yes |
| [33330743154](https://github.com/kaltrinaT/ai-chatbot-platform/actions/runs/33330743154) | aws | test341 | `23e1bfc+fd97da4` | yes | 0/0/0 | yes | — | yes |
| [34532602026](https://github.com/kaltrinaT/ai-chatbot-platform/actions/runs/34532602026) | aws | chatbot1023 | `39103b7+37f0595` | yes | 0/0/0 | yes | — | yes |
| [34537274330](https://github.com/kaltrinaT/ai-chatbot-platform/actions/runs/34537274330) | aws | chatbot1023 | `d4b6a8c+b39400a` | no | 1/0/0 | no | aws_lambda_permission.docs_signer_url created | yes |
| [34597969747](https://github.com/kaltrinaT/ai-chatbot-platform/actions/runs/34597969747) | aws | chatbot1023 | `55143b8+2eade1e` | no | 0/1/0 | no | aws_s3_bucket_cors_configuration.docs updated in-place | yes |
| [34649559368](https://github.com/kaltrinaT/ai-chatbot-platform/actions/runs/34649559368) | aws | test-chatbot-2 | `55143b8+2eade1e` | yes | 0/1/0 | no | aws_lambda_function.docs_signer updated in-place | yes |
| [34651488564](https://github.com/kaltrinaT/ai-chatbot-platform/actions/runs/34651488564) | aws | test-chatbot | `55143b8+4d96d9d` | no | 0/3/0 | no | aws_ecs_service.frontend updated in-place, aws_ecs_service.this updated in-place, aws_lambda_function.docs_signer updated in-place | yes |

A teardown's duration follows what it has to remove, so each is listed with Terraform's count of resources destroyed, beside what the same tenant's earlier deploys planned to add (from their logs, where retained). A teardown that destroys fewer resources than were created has left the difference to be removed some other way, or behind; only an inventory of the account (E4) can say which.

| Run | Cloud | Tenant | Vector store | Version | Resources destroyed | Its deploys planned | Attempts | Run |
|---|---|---|---|---|---:|---|---|---:|
| [33424386145](https://github.com/kaltrinaT/ai-chatbot-platform/actions/runs/33424386145) | aws | tenat746 | pgvector | `df53b3a+392f766` | 3 | +42 | failure → success | 0.3 |
| [33424533210](https://github.com/kaltrinaT/ai-chatbot-platform/actions/runs/33424533210) | aws | tenat1023 | pgvector | `df53b3a+392f766` | 3 | +42 | failure → success | 0.4 |
| [33424630595](https://github.com/kaltrinaT/ai-chatbot-platform/actions/runs/33424630595) | aws | test341 | pgvector | `df53b3a+392f766` | 3 | +20, +0, +0 | failure → success | 0.4 |
| [34766826435](https://github.com/kaltrinaT/ai-chatbot-platform/actions/runs/34766826435) | aws | company-info-chatbot-1 | pgvector | `890bd7c+0b9065e` | 0 | (failed) +40 | success | 0.5 |
| [34767959331](https://github.com/kaltrinaT/ai-chatbot-platform/actions/runs/34767959331) | aws | chatbot-test-3 | pgvector | `890bd7c+0b9065e` | 35 | +43 | success | 3.1 |
| [34767969890](https://github.com/kaltrinaT/ai-chatbot-platform/actions/runs/34767969890) | aws | test-chatbot-2 | pinecone | `890bd7c+0b9065e` | 31 | +38, +0 | success | 3.1 |
| [34767982569](https://github.com/kaltrinaT/ai-chatbot-platform/actions/runs/34767982569) | aws | chatbot1023 | pgvector | `890bd7c+0b9065e` | 35 | +42, +0, +1, +0 | success | 3.3 |
| [34768167335](https://github.com/kaltrinaT/ai-chatbot-platform/actions/runs/34768167335) | aws | test-chatbot | pinecone | `890bd7c+0b9065e` | 31 | +38, +0 | success | 3.3 |
| [34768192534](https://github.com/kaltrinaT/ai-chatbot-platform/actions/runs/34768192534) | aws | test-chatbot | pinecone | `890bd7c+0b9065e` | 15 | +38, +0 | success | 5.1 |
| [37130026980](https://github.com/kaltrinaT/ai-chatbot-platform/actions/runs/37130026980) | azure | hr-chatbot | pgvector | `724f22e+b5d756b` | 22 | (failed) +3/+21 | success | 4.7 |
| [37132196910](https://github.com/kaltrinaT/ai-chatbot-platform/actions/runs/37132196910) | azure | seeu-chatbot | pgvector | `724f22e+b5d756b` | 24 | (failed) +3, (failed) +0/+21, +0/+2 | success | 25.2 |
| [37461280184](https://github.com/kaltrinaT/ai-chatbot-platform/actions/runs/37461280184) | aws | compnay-info-chatbot | pgvector | `60d50d0+6842629` | 51 | (failed) +45, (failed) +3, (failed) +3, +9 | success | 12.8 |
| [37461306311](https://github.com/kaltrinaT/ai-chatbot-platform/actions/runs/37461306311) | azure | hr-chatbot-1 | pgvector | `724f22e+b5d756b` | — | (failed) +3/+21, +0/+2 | failure | 0.2 |

## 5. Redeploy campaigns

None recorded yet. Protocol: `docs/evaluation/live/RUNBOOK.md`, *Repeatability campaign*.

## 6. Why runs failed

Assigned by rule (`CATEGORIES` in the script) from the error lines and the failed step; the lines themselves are in the appendix so each assignment can be checked.

| Category | Runs | Failed stage (count) |
|---|---:|---|
| unclassified (log not retained) | 24 | workflow setup (9), cloud sign-in (5), terraform apply (10) |
| configuration or platform defect | 11 | terraform init (3), terraform apply (7), images (1) |
| credential or permission | 6 | terraform apply (5), cloud sign-in (1) |
| quota or limit | 4 | terraform apply (4) |
| cancelled | 1 | — (1) |
| account restriction | 1 | terraform apply (1) |

## 7. Consistency of the two records

34 runs have a platform record. Their outcome disagrees with GitHub's conclusion in 0. From Deploy pressed (T0) to GitHub creating the run: 1 s (0–1); 0–5 s. T5 relative to the run's last job completing: -2 s (-3–-2); -5–2 s; negative because the success callback is itself a step of the job, so T5 is recorded before the job's own clean-up ends. T5 − T0 and GitHub's run time therefore differ by little more than the queue, and either can stand for the workflow's duration.

What T5 − T0 does not include: the time from the run's success to a healthy chatbot (T6) and to its first grounded answer (T7). Those need a live probe: `node scripts/evaluate-live.cjs readiness`.

## Appendix: every run

<details><summary>Runs, oldest first</summary>

| Run | Created | Workflow and mode | Version | Vector store | Conclusion | Run | Queue | Platform | Failed step | Category | Error |
|---|---|---|---|---|---|---:|---:|---:|---|---|---|
| [26749604917](https://github.com/kaltrinaT/ai-chatbot-platform/actions/runs/26749604917) | 2026-06-01T10:33 | AWS unknown | `f8dbbe8+3223ce5` | — | failure | 0.2 | 0.1 | — | Pull source image | unclassified (log not retained) | — |
| [26754470031](https://github.com/kaltrinaT/ai-chatbot-platform/actions/runs/26754470031) | 2026-06-01T12:19 | AWS unknown | `f8dbbe8+3223ce5` | — | failure | 2.4 | 0.1 | — | Configure AWS credentials (client — assume tenant role) | unclassified (log not retained) | — |
| [26755553098](https://github.com/kaltrinaT/ai-chatbot-platform/actions/runs/26755553098) | 2026-06-01T12:42 | AWS unknown | `b1416db+3223ce5` | — | success | 5.0 | 0.1 | — | — |  | — |
| [27064529284](https://github.com/kaltrinaT/ai-chatbot-platform/actions/runs/27064529284) | 2026-06-06T14:11 | AWS unknown | `b1416db+3223ce5` | — | success | 2.0 | 0.1 | — | — |  | — |
| [27065466297](https://github.com/kaltrinaT/ai-chatbot-platform/actions/runs/27065466297) | 2026-06-06T14:53 | AWS unknown | `b1416db+3223ce5` | — | success | 1.4 | 0.1 | — | — |  | — |
| [27068079131](https://github.com/kaltrinaT/ai-chatbot-platform/actions/runs/27068079131) | 2026-06-06T16:46 | AWS unknown | `b1416db+abae2e7` | — | success | 5.9 | 0.1 | — | — |  | — |
| [27077360392](https://github.com/kaltrinaT/ai-chatbot-platform/actions/runs/27077360392) | 2026-06-06T23:54 | AWS unknown | `b1416db+abae2e7` | — | failure | 9.1 | 0.1 | — | Terraform apply | unclassified (log not retained) | — |
| [27078359503](https://github.com/kaltrinaT/ai-chatbot-platform/actions/runs/27078359503) | 2026-06-07T00:45 | AWS unknown | `b1416db+abae2e7` | — | success | 6.2 | 0.1 | — | — |  | — |
| [27477217918](https://github.com/kaltrinaT/ai-chatbot-platform/actions/runs/27477217918) | 2026-06-13T19:47 | AZURE unknown | `ad91e38+3f6b9ad` | — | failure | 0.1 | 0.1 | — | Configure AWS credentials (pull source image from platform ECR) | unclassified (log not retained) | — |
| [27881232793](https://github.com/kaltrinaT/ai-chatbot-platform/actions/runs/27881232793) | 2026-06-20T19:16 | AWS unknown | `2dcd77f+abae2e7` | — | cancelled | 30.3 | 0.1 | — | — | cancelled | — |
| [27882070838](https://github.com/kaltrinaT/ai-chatbot-platform/actions/runs/27882070838) | 2026-06-20T19:51 | AWS unknown | `2dcd77f+d03212e` | — | success | 6.1 | 0.1 | — | — |  | — |
| [27882759521](https://github.com/kaltrinaT/ai-chatbot-platform/actions/runs/27882759521) | 2026-06-20T20:19 | AWS unknown | `bf3bcde+31fad18` | — | success | 6.3 | 0.1 | — | — |  | — |
| [27903966971](https://github.com/kaltrinaT/ai-chatbot-platform/actions/runs/27903966971) | 2026-06-21T12:13 | AWS unknown | `8aee30e+b1aa1fd` | — | failure | 0.1 | 0.1 | — | Create Pinecone index | unclassified (log not retained) | — |
| [27904117005](https://github.com/kaltrinaT/ai-chatbot-platform/actions/runs/27904117005) | 2026-06-21T12:19 | AWS unknown | `8aee30e+b1aa1fd` | — | failure | 2.9 | 0.1 | — | Terraform apply | unclassified (log not retained) | — |
| [27904512345](https://github.com/kaltrinaT/ai-chatbot-platform/actions/runs/27904512345) | 2026-06-21T12:35 | AWS unknown | `8aee30e+b1aa1fd` | — | success | 5.0 | 0.1 | — | — |  | — |
| [27907811375](https://github.com/kaltrinaT/ai-chatbot-platform/actions/runs/27907811375) | 2026-06-21T14:44 | AWS unknown | `8aee30e+b1aa1fd` | — | success | 5.8 | 0.1 | — | — |  | — |
| [27908733265](https://github.com/kaltrinaT/ai-chatbot-platform/actions/runs/27908733265) | 2026-06-21T15:20 | AWS unknown | `8aee30e+e6e14a0` | — | success | 6.2 | 0.1 | — | — |  | — |
| [27923567866](https://github.com/kaltrinaT/ai-chatbot-platform/actions/runs/27923567866) | 2026-06-22T01:10 | AWS unknown | `8aee30e+e6e14a0` | — | success | 7.3 | 0.1 | — | — |  | — |
| [27924566255](https://github.com/kaltrinaT/ai-chatbot-platform/actions/runs/27924566255) | 2026-06-22T01:46 | AWS unknown | `4157f7a+cfd9f3f` | — | success | 5.6 | 0.1 | — | — |  | — |
| [27949136249](https://github.com/kaltrinaT/ai-chatbot-platform/actions/runs/27949136249) | 2026-06-22T11:23 | AWS unknown | `4157f7a+cfd9f3f` | — | success | 6.0 | 0.1 | — | — |  | — |
| [27955608635](https://github.com/kaltrinaT/ai-chatbot-platform/actions/runs/27955608635) | 2026-06-22T13:17 | AWS unknown | `4157f7a+cfd9f3f` | — | success | 4.8 | 0.1 | — | — |  | — |
| [27960970123](https://github.com/kaltrinaT/ai-chatbot-platform/actions/runs/27960970123) | 2026-06-22T14:41 | AWS unknown | `4157f7a+cfd9f3f` | — | success | 1.4 | 0.2 | — | — |  | — |
| [27967940512](https://github.com/kaltrinaT/ai-chatbot-platform/actions/runs/27967940512) | 2026-06-22T16:29 | AWS unknown | `4157f7a+b8e36d2` | — | success | 6.3 | 0.1 | — | — |  | — |
| [27971276552](https://github.com/kaltrinaT/ai-chatbot-platform/actions/runs/27971276552) | 2026-06-22T17:25 | AWS unknown | `4157f7a+b8e36d2` | — | success | 4.8 | 0.1 | — | — |  | — |
| [27986433495](https://github.com/kaltrinaT/ai-chatbot-platform/actions/runs/27986433495) | 2026-06-22T21:51 | AWS unknown | `d592e18+99e9f18` | — | success | 4.6 | 0.1 | — | — |  | — |
| [27987922206](https://github.com/kaltrinaT/ai-chatbot-platform/actions/runs/27987922206) | 2026-06-22T22:20 | AWS unknown | `d592e18+99e9f18` | — | success | 8.0 | 0.1 | — | — |  | — |
| [28102827807](https://github.com/kaltrinaT/ai-chatbot-platform/actions/runs/28102827807) | 2026-06-24T13:41 | AZURE unknown | `3c55ba7+9152cef` | — | failure | 1.2 | 0.1 | — | Create ACR if not exists and push image | unclassified (log not retained) | — |
| [28104429717](https://github.com/kaltrinaT/ai-chatbot-platform/actions/runs/28104429717) | 2026-06-24T14:05 | AZURE unknown | `897b62d+9152cef` | — | failure | 1.2 | 0.1 | — | Azure login | unclassified (log not retained) | — |
| [28105011844](https://github.com/kaltrinaT/ai-chatbot-platform/actions/runs/28105011844) | 2026-06-24T14:15 | AZURE unknown | `897b62d+9152cef` | — | failure | 1.3 | 0.1 | — | Create ACR if not exists and push image | unclassified (log not retained) | — |
| [28109620128](https://github.com/kaltrinaT/ai-chatbot-platform/actions/runs/28109620128) | 2026-06-24T15:24 | AZURE unknown | `897b62d+9152cef` | — | failure | 1.2 | 0.1 | — | Create ACR if not exists and push image | unclassified (log not retained) | — |
| [28129730855](https://github.com/kaltrinaT/ai-chatbot-platform/actions/runs/28129730855) | 2026-06-24T21:08 | AZURE unknown | `897b62d+9152cef` | — | failure | 1.6 | 0.1 | — | Create ACR if not exists and push image | unclassified (log not retained) | — |
| [28130448255](https://github.com/kaltrinaT/ai-chatbot-platform/actions/runs/28130448255) | 2026-06-24T21:22 | AZURE unknown | `897b62d+9152cef` | — | failure | 1.6 | 0.1 | — | Terraform apply | unclassified (log not retained) | — |
| [28137351982](https://github.com/kaltrinaT/ai-chatbot-platform/actions/runs/28137351982) | 2026-06-24T23:55 | AZURE unknown | `897b62d+15f2a86` | — | failure | 1.2 | 0.1 | — | Create ACR if not exists and push image | unclassified (log not retained) | — |
| [28137613778](https://github.com/kaltrinaT/ai-chatbot-platform/actions/runs/28137613778) | 2026-06-25T00:02 | AZURE unknown | `897b62d+15f2a86` | — | failure | 1.5 | 0.1 | — | Terraform apply | unclassified (log not retained) | — |
| [28139644592](https://github.com/kaltrinaT/ai-chatbot-platform/actions/runs/28139644592) | 2026-06-25T00:57 | AZURE unknown | `897b62d+87c55cb` | — | failure | 2.9 | 0.1 | — | Terraform apply | unclassified (log not retained) | — |
| [28139903902](https://github.com/kaltrinaT/ai-chatbot-platform/actions/runs/28139903902) | 2026-06-25T01:04 | AZURE unknown | `897b62d+48128ce` | — | failure | 1.2 | 0.1 | — | Azure login | unclassified (log not retained) | — |
| [28140048434](https://github.com/kaltrinaT/ai-chatbot-platform/actions/runs/28140048434) | 2026-06-25T01:08 | AZURE unknown | `897b62d+48128ce` | — | failure | 3.1 | 0.1 | — | Terraform apply | unclassified (log not retained) | — |
| [28172499201](https://github.com/kaltrinaT/ai-chatbot-platform/actions/runs/28172499201) | 2026-06-25T13:10 | AZURE unknown | `897b62d+48128ce` | — | failure | 1.3 | 0.1 | — | Create ACR if not exists and push image | unclassified (log not retained) | — |
| [28173094435](https://github.com/kaltrinaT/ai-chatbot-platform/actions/runs/28173094435) | 2026-06-25T13:20 | AZURE unknown | `897b62d+48128ce` | — | failure | 3.2 | 0.1 | — | Terraform apply | unclassified (log not retained) | — |
| [28174759587](https://github.com/kaltrinaT/ai-chatbot-platform/actions/runs/28174759587) | 2026-06-25T13:46 | AZURE unknown | `897b62d+48128ce` | — | failure | 3.5 | 0.2 | — | Terraform apply | unclassified (log not retained) | — |
| [28177009714](https://github.com/kaltrinaT/ai-chatbot-platform/actions/runs/28177009714) | 2026-06-25T14:21 | AZURE unknown | `c6a6d59+48128ce` | — | failure | 6.3 | 0.1 | — | Terraform apply | unclassified (log not retained) | — |
| [28189792230](https://github.com/kaltrinaT/ai-chatbot-platform/actions/runs/28189792230) | 2026-06-25T17:54 | AZURE unknown | `93c1957+48128ce` | — | success | 3.1 | 0.1 | — | — |  | — |
| [28206815854](https://github.com/kaltrinaT/ai-chatbot-platform/actions/runs/28206815854) | 2026-06-25T23:24 | AZURE unknown | `93c1957+4017b2b` | — | failure | 6.7 | 0.1 | — | Terraform apply | unclassified (log not retained) | — |
| [28207345707](https://github.com/kaltrinaT/ai-chatbot-platform/actions/runs/28207345707) | 2026-06-25T23:37 | AZURE unknown | `93c1957+4017b2b` | — | failure | 1.7 | 0.1 | — | Create ACR if not exists and push image | unclassified (log not retained) | — |
| [28238314558](https://github.com/kaltrinaT/ai-chatbot-platform/actions/runs/28238314558) | 2026-06-26T12:34 | AZURE unknown | `93c1957+4017b2b` | — | failure | 1.2 | 0.1 | — | Azure login | unclassified (log not retained) | — |
| [28238785120](https://github.com/kaltrinaT/ai-chatbot-platform/actions/runs/28238785120) | 2026-06-26T12:43 | AZURE unknown | `93c1957+4017b2b` | — | success | 6.5 | 0.1 | — | — |  | — |
| [28243622917](https://github.com/kaltrinaT/ai-chatbot-platform/actions/runs/28243622917) | 2026-06-26T14:13 | AZURE unknown | `93c1957+4017b2b` | — | success | 2.5 | 0.1 | — | — |  | — |
| [28250349996](https://github.com/kaltrinaT/ai-chatbot-platform/actions/runs/28250349996) | 2026-06-26T16:12 | AZURE unknown | `93c1957+4017b2b` | — | success | 6.3 | 0.1 | — | — |  | — |
| [28271536200](https://github.com/kaltrinaT/ai-chatbot-platform/actions/runs/28271536200) | 2026-06-26T23:45 | AWS unknown | `7ff785a+507eebb` | — | success | 1.5 | 0.1 | — | — |  | — |
| [33027328666](https://github.com/kaltrinaT/ai-chatbot-platform/actions/runs/33027328666) | 2026-08-27T00:35 | AWS unknown | `5f7e130+b9a70c1` | — | failure | 1.4 | 0.1 | — | Terraform init | configuration or platform defect | │ Error: Failed to get existing workspaces: S3 bucket "***" does not exist. |
| [33040175048](https://github.com/kaltrinaT/ai-chatbot-platform/actions/runs/33040175048) | 2026-08-27T04:41 | AWS unknown | `5f7e130+b9a70c1` | — | failure | 2.8 | 0.1 | — | Terraform init | configuration or platform defect | │ Error: Failed to get existing workspaces: S3 bucket "***" does not exist. |
| [33042186140](https://github.com/kaltrinaT/ai-chatbot-platform/actions/runs/33042186140) | 2026-08-27T05:20 | AWS unknown | `5f7e130+b9a70c1` | — | failure | 1.3 | 0.1 | — | Terraform init | configuration or platform defect | │ Error: Error refreshing state: Unable to access object "tenants/tenat1641.tfstate" in S3 bucket "***": operation error S3: HeadObject, htt |
| [33042282789](https://github.com/kaltrinaT/ai-chatbot-platform/actions/runs/33042282789) | 2026-08-27T05:22 | AWS first deploy (inferred) · pgvector | `5f7e130+b9a70c1` | pgvector | failure | 1.6 | 0.1 | — | Terraform apply | credential or permission | │ Error: No credentials provided |
| [33042970805](https://github.com/kaltrinaT/ai-chatbot-platform/actions/runs/33042970805) | 2026-08-27T05:35 | AWS first deploy (inferred) · pgvector | `c00f8db+b9a70c1` | pgvector | failure | 10.3 | 0.1 | — | Terraform apply | configuration or platform defect | │ Error: setting S3 Bucket (chatbot-tenat1721-docs) tags: listing resource tags (chatbot-tenat1721-docs): operation error S3: GetBucketTaggi |
| [33043831246](https://github.com/kaltrinaT/ai-chatbot-platform/actions/runs/33043831246) | 2026-08-27T05:51 | AWS unknown · pgvector | `c00f8db+b9a70c1` | pgvector | failure | 1.8 | 0.1 | — | Terraform apply | credential or permission | │ Error: reading S3 Bucket (chatbot-tenat1721-docs) policy: operation error S3: GetBucketPolicy, https response error StatusCode: 403, Reque |
| [33044793515](https://github.com/kaltrinaT/ai-chatbot-platform/actions/runs/33044793515) | 2026-08-27T06:08 | AWS unknown · pgvector | `c00f8db+b9a70c1` | pgvector | success | 1.6 | 0.1 | — | — |  | — |
| [33053018358](https://github.com/kaltrinaT/ai-chatbot-platform/actions/runs/33053018358) | 2026-08-27T08:12 | AWS first deploy (inferred) · pgvector | `c00f8db+b9a70c1` | pgvector | success | 12.7 | 0.1 | — | — |  | — |
| [33057905151](https://github.com/kaltrinaT/ai-chatbot-platform/actions/runs/33057905151) | 2026-08-27T09:17 | AWS first deploy (inferred) · pinecone | `c00f8db+b9a70c1` | pinecone | failure | 6.3 | 0.1 | — | Terraform apply | configuration or platform defect | │ Error: Failed to create serverless index |
| [33310500744](https://github.com/kaltrinaT/ai-chatbot-platform/actions/runs/33310500744) | 2026-08-30T12:04 | AWS first deploy (inferred) · pgvector | `23e1bfc+fd97da4` | pgvector | failure | 11.9 | 0.1 | — | Terraform apply | credential or permission | │ Error: creating Lambda Function (chatbot-tenat1203-docs-signer): operation error Lambda: CreateFunction, https response error StatusCode:  |
| [33313730046](https://github.com/kaltrinaT/ai-chatbot-platform/actions/runs/33313730046) | 2026-08-30T13:16 | AWS unknown · pgvector | `23e1bfc+fd97da4` | pgvector | failure | 1.6 | 0.1 | — | Terraform apply | credential or permission | │ Error: creating Lambda Function (chatbot-tenat1203-docs-signer): operation error Lambda: CreateFunction, https response error StatusCode:  |
| [33314867180](https://github.com/kaltrinaT/ai-chatbot-platform/actions/runs/33314867180) | 2026-08-30T13:41 | AWS first deploy (inferred) · pgvector | `23e1bfc+fd97da4` | pgvector | success | 8.2 | 0.1 | — | — |  | — |
| [33317063872](https://github.com/kaltrinaT/ai-chatbot-platform/actions/runs/33317063872) | 2026-08-30T14:30 | AWS redeploy (inferred) · pgvector | `23e1bfc+fd97da4` | pgvector | success | 1.6 | 0.1 | — | — |  | — |
| [33330743154](https://github.com/kaltrinaT/ai-chatbot-platform/actions/runs/33330743154) | 2026-08-30T19:23 | AWS redeploy (inferred) · pgvector | `23e1bfc+fd97da4` | pgvector | success | 1.9 | 0.1 | — | — |  | — |
| [33330937908](https://github.com/kaltrinaT/ai-chatbot-platform/actions/runs/33330937908) | 2026-08-30T19:27 | AWS first deploy (inferred) · pgvector | `23e1bfc+fd97da4` | pgvector | success | 10.1 | 0.1 | — | — |  | — |
| [33333533591](https://github.com/kaltrinaT/ai-chatbot-platform/actions/runs/33333533591) | 2026-08-30T20:23 | AWS first deploy (inferred) · pgvector | `23e1bfc+fd97da4` | pgvector | success | 12.0 | 0.1 | — | — |  | — |
| [33403453883](https://github.com/kaltrinaT/ai-chatbot-platform/actions/runs/33403453883) | 2026-08-31T14:34 | AWS first deploy (inferred) · pgvector | `23e1bfc+e3d1a74` | pgvector | failure | 3.7 | 0.1 | — | Terraform apply | quota or limit | │ Error: creating EC2 VPC: operation error EC2: CreateVpc, https response error StatusCode: 400, RequestID: <uuid>, api error VpcLimitExceed |
| [33421413335](https://github.com/kaltrinaT/ai-chatbot-platform/actions/runs/33421413335) | 2026-08-31T17:46 | AWS first deploy (inferred) · pgvector | `23e1bfc+392f766` | pgvector | success | 9.8 | 0.1 | — | — |  | — |
| [33424386145](https://github.com/kaltrinaT/ai-chatbot-platform/actions/runs/33424386145) | 2026-08-31T18:19 | AWS teardown · pgvector | `df53b3a+392f766` | pgvector | success | 0.3 | 0.1 | — | — |  | — |
| [33424533210](https://github.com/kaltrinaT/ai-chatbot-platform/actions/runs/33424533210) | 2026-08-31T18:21 | AWS teardown · pgvector | `df53b3a+392f766` | pgvector | success | 0.4 | 0.1 | — | — |  | — |
| [33424630595](https://github.com/kaltrinaT/ai-chatbot-platform/actions/runs/33424630595) | 2026-08-31T18:22 | AWS teardown · pgvector | `df53b3a+392f766` | pgvector | success | 0.4 | 0.1 | — | — |  | — |
| [33433324337](https://github.com/kaltrinaT/ai-chatbot-platform/actions/runs/33433324337) | 2026-08-31T19:56 | AWS first deploy (inferred) · pgvector | `23e1bfc+392f766` | pgvector | success | 9.8 | 0.1 | — | — |  | — |
| [34527357062](https://github.com/kaltrinaT/ai-chatbot-platform/actions/runs/34527357062) | 2026-09-10T20:36 | AWS first deploy · pgvector | `39103b7+37f0595` | pgvector | success | 10.5 | 0.1 | 10.6 | — |  | — |
| [34532602026](https://github.com/kaltrinaT/ai-chatbot-platform/actions/runs/34532602026) | 2026-09-10T21:30 | AWS redeploy · pgvector | `39103b7+37f0595` | pgvector | success | 1.7 | 0.1 | 1.8 | — |  | — |
| [34537274330](https://github.com/kaltrinaT/ai-chatbot-platform/actions/runs/34537274330) | 2026-09-10T22:24 | AWS redeploy · pgvector | `d4b6a8c+b39400a` | pgvector | success | 2.3 | 0.1 | 2.5 | — |  | HTTP 404 posting 'running' to PLATFORM_BASE_URL. <!DOCTYPE html> |
| [34597969747](https://github.com/kaltrinaT/ai-chatbot-platform/actions/runs/34597969747) | 2026-09-11T12:15 | AWS redeploy · pgvector | `55143b8+2eade1e` | pgvector | success | 1.8 | 0.1 | 2.0 | — |  | HTTP 404 posting 'running' to PLATFORM_BASE_URL. <!DOCTYPE html> |
| [34634167852](https://github.com/kaltrinaT/ai-chatbot-platform/actions/runs/34634167852) | 2026-09-11T18:35 | AWS first deploy · pinecone | `55143b8+2eade1e` | pinecone | success | 6.9 | 0.1 | 7.0 | — |  | — |
| [34638044293](https://github.com/kaltrinaT/ai-chatbot-platform/actions/runs/34638044293) | 2026-09-11T19:17 | AWS first deploy · pinecone | `55143b8+2eade1e` | pinecone | success | 7.0 | 0.1 | 7.2 | — |  | — |
| [34649559368](https://github.com/kaltrinaT/ai-chatbot-platform/actions/runs/34649559368) | 2026-09-11T21:28 | AWS redeploy · pinecone | `55143b8+2eade1e` | pinecone | success | 3.3 | 0.1 | 3.4 | — |  | — |
| [34651488564](https://github.com/kaltrinaT/ai-chatbot-platform/actions/runs/34651488564) | 2026-09-11T21:53 | AWS redeploy · pinecone | `55143b8+4d96d9d` | pinecone | success | 2.6 | 0.1 | 2.7 | — |  | — |
| [34653106393](https://github.com/kaltrinaT/ai-chatbot-platform/actions/runs/34653106393) | 2026-09-11T22:14 | AWS first deploy · pgvector | `55143b8+4d96d9d` | pgvector | success | 12.0 | 0.1 | 12.0 | — |  | — |
| [34761008326](https://github.com/kaltrinaT/ai-chatbot-platform/actions/runs/34761008326) | 2026-09-13T13:51 | AWS first deploy · pgvector | `2f8fc9c+0566d14` | pgvector | failure | 2.5 | 0.1 | 2.6 | Terraform apply | credential or permission | │ Error: listing CloudFront Cache Policies: operation error CloudFront: ListCachePolicies, https response error StatusCode: 403, RequestID:  |
| [34761619166](https://github.com/kaltrinaT/ai-chatbot-platform/actions/runs/34761619166) | 2026-09-13T14:04 | AWS first deploy · pgvector | `2f8fc9c+0566d14` | pgvector | failure | 24.5 | 0.1 | 24.6 | Terraform apply | account restriction | │ Error: creating CloudFront Distribution: operation error CloudFront: CreateDistributionWithTags, https response error StatusCode: 403, Req |
| [34765075295](https://github.com/kaltrinaT/ai-chatbot-platform/actions/runs/34765075295) | 2026-09-13T15:15 | AWS first deploy · pgvector | `2f8fc9c+02ec413` | pgvector | failure | 2.5 | 0.1 | 2.5 | Terraform apply | configuration or platform defect | │ Error: "name" cannot be longer than 32 characters |
| [34766826435](https://github.com/kaltrinaT/ai-chatbot-platform/actions/runs/34766826435) | 2026-09-13T15:51 | AWS teardown (nothing to destroy) · pgvector | `890bd7c+0b9065e` | pgvector | success | 0.5 | 0.1 | 0.6 | — |  | — |
| [34767152562](https://github.com/kaltrinaT/ai-chatbot-platform/actions/runs/34767152562) | 2026-09-13T15:57 | AWS first deploy · pgvector | `2f8fc9c+0b9065e` | pgvector | failure | 3.0 | 0.1 | 3.1 | Terraform apply | quota or limit | │ Error: creating EC2 VPC: operation error EC2: CreateVpc, https response error StatusCode: 400, RequestID: <uuid>, api error VpcLimitExceed |
| [34767959331](https://github.com/kaltrinaT/ai-chatbot-platform/actions/runs/34767959331) | 2026-09-13T16:14 | AWS teardown · pgvector | `890bd7c+0b9065e` | pgvector | success | 3.1 | 0.1 | 3.1 | — |  | — |
| [34767969890](https://github.com/kaltrinaT/ai-chatbot-platform/actions/runs/34767969890) | 2026-09-13T16:14 | AWS teardown · pinecone | `890bd7c+0b9065e` | pinecone | success | 3.1 | 0.1 | 3.2 | — |  | — |
| [34767982569](https://github.com/kaltrinaT/ai-chatbot-platform/actions/runs/34767982569) | 2026-09-13T16:14 | AWS teardown · pgvector | `890bd7c+0b9065e` | pgvector | success | 3.3 | 0.1 | 3.3 | — |  | — |
| [34768167335](https://github.com/kaltrinaT/ai-chatbot-platform/actions/runs/34768167335) | 2026-09-13T16:18 | AWS teardown · pinecone | `890bd7c+0b9065e` | pinecone | success | 3.3 | 0.1 | 3.4 | — |  | — |
| [34768192534](https://github.com/kaltrinaT/ai-chatbot-platform/actions/runs/34768192534) | 2026-09-13T16:18 | AWS teardown · pinecone | `890bd7c+0b9065e` | pinecone | success | 5.1 | 0.1 | 5.2 | — |  | — |
| [34768411999](https://github.com/kaltrinaT/ai-chatbot-platform/actions/runs/34768411999) | 2026-09-13T16:23 | AWS first deploy · pgvector | `2f8fc9c+0b9065e` | pgvector | success | 12.0 | 0.1 | 12.1 | — |  | — |
| [36637828399](https://github.com/kaltrinaT/ai-chatbot-platform/actions/runs/36637828399) | 2026-09-29T22:09 | AZURE first deploy · pgvector | `7113a75+2c30418` | pgvector | failure | 4.8 | 0.1 | 4.9 | Retag and push images to tenant ACR | configuration or platform defect | Process completed with exit code 1. |
| [36640227188](https://github.com/kaltrinaT/ai-chatbot-platform/actions/runs/36640227188) | 2026-09-29T22:33 | AZURE first deploy · pgvector | `b014981+2c30418` | pgvector | failure | 9.3 | 0.1 | 9.4 | Terraform apply — full deploy | configuration or platform defect | │ Error: creating Container App (Subscription: "<uuid>" |
| [36702467937](https://github.com/kaltrinaT/ai-chatbot-platform/actions/runs/36702467937) | 2026-09-30T10:26 | AZURE first deploy · pgvector | `b014981+34c48ae` | pgvector | success | 8.5 | 0.1 | 8.7 | — |  | — |
| [37128904771](https://github.com/kaltrinaT/ai-chatbot-platform/actions/runs/37128904771) | 2026-10-03T14:13 | AZURE first deploy · pgvector | `b014981+b5d756b` | pgvector | failure | 11.9 | 0.1 | 12.0 | Terraform apply — full deploy | configuration or platform defect | │ Error: Failed to create/update resource |
| [37130026980](https://github.com/kaltrinaT/ai-chatbot-platform/actions/runs/37130026980) | 2026-10-03T14:33 | AZURE teardown · pgvector | `724f22e+b5d756b` | pgvector | success | 4.7 | 0.1 | 4.7 | — |  | — |
| [37131153968](https://github.com/kaltrinaT/ai-chatbot-platform/actions/runs/37131153968) | 2026-10-03T14:51 | AZURE first deploy · pgvector | `b014981+b5d756b` | pgvector | failure | 12.9 | 0.1 | 13.0 | Terraform apply — full deploy | configuration or platform defect | │ Error: Failed to create/update resource |
| [37132196910](https://github.com/kaltrinaT/ai-chatbot-platform/actions/runs/37132196910) | 2026-10-03T15:08 | AZURE teardown · pgvector | `724f22e+b5d756b` | pgvector | success | 25.2 | 0.1 | 25.3 | — |  | — |
| [37133733196](https://github.com/kaltrinaT/ai-chatbot-platform/actions/runs/37133733196) | 2026-10-03T15:34 | AZURE first deploy · pgvector | `b014981+b5d756b` | pgvector | success | 19.7 | 0.1 | 19.8 | — |  | — |
| [37134553206](https://github.com/kaltrinaT/ai-chatbot-platform/actions/runs/37134553206) | 2026-10-03T15:48 | AWS first deploy · pgvector | `ee2facd+08171a0` | pgvector | failure | 5.8 | 0.1 | 5.8 | Terraform apply | configuration or platform defect | │ Error: creating RDS DB Instance (chatbot-compnay-info-chatbot-vectors): operation error RDS: CreateDBInstance, https response error Status |
| [37138293682](https://github.com/kaltrinaT/ai-chatbot-platform/actions/runs/37138293682) | 2026-10-03T16:49 | AWS first deploy · pgvector | `ee2facd+7eb3ee9` | pgvector | failure | 1.4 | 0.1 | 1.5 | Terraform apply | quota or limit | │ Error: creating RDS DB Instance (chatbot-compnay-info-chatbot-vectors): operation error RDS: CreateDBInstance, https response error Status |
| [37138434111](https://github.com/kaltrinaT/ai-chatbot-platform/actions/runs/37138434111) | 2026-10-03T16:52 | AWS first deploy · pgvector | `ee2facd+7eb3ee9` | pgvector | failure | 1.5 | 0.1 | 1.6 | Terraform apply | quota or limit | │ Error: creating RDS DB Instance (chatbot-compnay-info-chatbot-vectors): operation error RDS: CreateDBInstance, https response error Status |
| [37139514235](https://github.com/kaltrinaT/ai-chatbot-platform/actions/runs/37139514235) | 2026-10-03T17:10 | AWS first deploy · pgvector | `ee2facd+6842629` | pgvector | success | 8.9 | 0.1 | 9.0 | — |  | — |
| [37461280184](https://github.com/kaltrinaT/ai-chatbot-platform/actions/runs/37461280184) | 2026-10-06T12:09 | AWS teardown · pgvector | `60d50d0+6842629` | pgvector | success | 12.8 | 0.1 | 13.0 | — |  | — |
| [37461306311](https://github.com/kaltrinaT/ai-chatbot-platform/actions/runs/37461306311) | 2026-10-06T12:09 | AZURE teardown · pgvector | `724f22e+b5d756b` | pgvector | failure | 0.2 | 0.1 | 0.3 | Azure login (customer subscription, federated credential) | credential or permission | AADSTS700016: Application with identifier '***' was not found in the directory '<uuid>'. This can happen if the application has not been ins |

</details>

## Reproducing

`node scripts/evaluate-deployment-timings.cjs extract` (needs `GITHUB_PAT`, `CHATBOT_REPO_OWNER`, `CHATBOT_REPO_NAME`, and `DATABASE_URL` for the join; read-only), then `… report`. `runs.json` is the archive; it only grows, and keeps what was read from logs GitHub has since expired.
