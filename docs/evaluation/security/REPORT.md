# Security evaluation

Generated 2026-10-16T22:55:46.232Z by `node scripts/evaluate-security.cjs --target https://ai-chatbot-platform-gamma.vercel.app` at commit `61de49007640` with uncommitted changes. Every test is read-only; see the script header for what the live tests send.

Each test turns one claim from `SECURITY.md` or `ARCHITECTURE.md` into a pass/fail criterion (`EVALUATION.md` §5). S8 to S10 extend the original seven. A static result is evidence about the code and templates as written, not about every deployed tenant.

| ID | Cloud | Claim | Result | Method |
|---|---|---|---|---|
| S1 | both | One tenant's chatbot cannot retrieve another tenant's documents | **NOT RUN** | Canary documents in two live tenants |
| S2 | aws | The platform holds no credential able to read a tenant document | **PASS** | Static IAM evaluation of every role in the bootstrap template against the control-plane policy as written and as deployed, rendered for a sample tenant; negative controls throughout |
| S2 | azure | The platform holds no credential able to read a tenant document | **PASS** | Static: the application's dependencies and imports |
| S3 | both | The docs-signer can write and delete documents but never read or list them | **PASS** | Static: every policy attached to the signer's role (AWS) and every role assigned to the signer's identity (Azure) |
| S4 | aws | Platform activity in a customer account stays within the documented inventory | **NOT RUN** | CloudTrail events of one full deploy |
| S5 | both | The deployment webhooks cannot be forged or replayed | **PASS** | Live requests to https://ai-chatbot-platform-gamma.vercel.app: near-miss webhook secrets, a replay against a finished deployment, and forged GitHub OIDC tokens; unit tests in src/app/api/deployments/[id]/status/route.test.ts and src/lib/deploymentSecrets.test.ts cover the same paths in-process |
| S6 | both | No secret is recoverable from the public repository or its CI logs | **PASS** | gitleaks (default rules plus OpenRouter and Pinecone) over every commit and every retained Actions log, with reviewed false positives; exact search for every secret the operator holds |
| S7 | both | No secret is stored in plaintext; stored secrets are AES-256-GCM ciphertexts | **PASS** | Read-only queries: format, authentication under the current key and IV uniqueness of every stored ciphertext; erasure on deleted tenants; a credential-pattern scan of every text column of every table |
| S8 | both | Only a run in the tenant's own GitHub environment can sign in to its cloud | **PASS (static)** | Static: AWS trust policy evaluated against forged token claims; Azure federated credential checked against the expected subject expression. The live half (a real token from another environment) is not run. |
| S9 | both | Dispatching a workflow cannot make it run anything but its own steps | **PASS** | Every run: script parsed for a dispatch input or step output expanded in place; zizmor's template-injection audit as corroboration |
| S10 | both | One operator cannot reach another operator's tenants through the platform | **PASS** | Every tenant-scoped action's real SQL run against a fake database holding two operators' tenants (src/app/tenantIsolation.test.ts), each refusal paired with a control on the operator's own tenant; S10.1 also live against https://ai-chatbot-platform-gamma.vercel.app |

## S1 (both): not run

- Needs two tenants deployed at once; run scripts/evaluate-live.cjs isolation.

## S2 (aws): PASS

**Claim.** The platform holds no credential able to read a tenant document.

No role completes the path. The role the platform may assume (chatbot-client-onboard-acme) cannot read the bucket, and every role that can read it refuses the platform.

**Path through `chatbot-client-deploy-acme`: broken.**

| Step | Decision | Statements | Evidence |
|---|---|---|---|
| The platform role may call sts:AssumeRole on chatbot-client-deploy-acme | Allow | AssumeCustomerDeploymentRoles | infra/platform/control-plane/main.tf: ImplicitDeny; infra/platform/control-plane/terraform.tfstate (deployed, state serial 9): Allow |
| chatbot-client-deploy-acme trusts the platform account when it sends the tenant ID as ExternalId | ImplicitDeny |  | infra/bootstrap/aws/tenant-bootstrap.yaml:204 |
| chatbot-client-deploy-acme may read a document | Allow | Storage | infra/bootstrap/aws/tenant-bootstrap.yaml:204 |
| chatbot-client-deploy-acme may list the documents bucket | Allow | Storage | infra/bootstrap/aws/tenant-bootstrap.yaml:204 |

**Path through `chatbot-client-onboard-acme`: broken.**

| Step | Decision | Statements | Evidence |
|---|---|---|---|
| The platform role may call sts:AssumeRole on chatbot-client-onboard-acme | Allow | AssumeCustomerOnboardingRoles | infra/platform/control-plane/main.tf: Allow; infra/platform/control-plane/terraform.tfstate (deployed, state serial 9): ImplicitDeny |
| chatbot-client-onboard-acme trusts the platform account when it sends the tenant ID as ExternalId | Allow | PlatformOnboarding | infra/bootstrap/aws/tenant-bootstrap.yaml:410 |
| chatbot-client-onboard-acme may read a document | ImplicitDeny |  | infra/bootstrap/aws/tenant-bootstrap.yaml:410 |
| chatbot-client-onboard-acme may list the documents bucket | ImplicitDeny |  | infra/bootstrap/aws/tenant-bootstrap.yaml:410 |

Negative controls, each expected to be refused (so a PASS or FAIL is not an artefact of the evaluator):

| Control | Decision |
|---|---|
| Another tenant's ExternalId is refused | ImplicitDeny |
| A request without ExternalId is refused | ImplicitDeny |
| A principal in another AWS account is refused | ImplicitDeny |
| The platform role may not assume an unrelated role | ImplicitDeny |
| The deployment role may not edit its own IAM role | ExplicitDeny |
| The onboarding role may not read a secret back | ImplicitDeny |
| The deployment role may not widen the onboarding role | ExplicitDeny |

Who can act as the platform role, from its deployed trust policy:

- OperatorSignInSession: {"AWS":"arn:aws:iam::<account>:user/kaltrina"} when {"Null":{"aws:TokenIssueTime":"false"}}
- HostWorkloadIdentity: {"Federated":"arn:aws:iam::<account>:oidc-provider/oidc.vercel.com/kaltrina127316s-projects"} when {"StringEquals":{"oidc.vercel.com/kaltrina127316s-projects:aud":"https://vercel.com/kaltrina127316s-projects","oidc.vercel.com/kaltrina127316s-projects:sub":"owner:kaltrina127316s-projects:project:ai-chatbot-platform:environment:production"}}

- Documents bucket policy: none declared (infra/terraform/main.tf), so no resource policy changes these decisions
- The deployed control-plane policy differs from infra/platform/control-plane/main.tf: apply it, or onboarding cannot assume the new role.
- The platform role may assume the onboarding role: Allow
- The onboarding role may create this tenant's secret: Allow

## S2 (azure): PASS

**Claim.** The platform holds no credential able to read a tenant document.

The application carries no Azure SDK and stores no Azure credential. Reach into a subscription exists only through a deploy-workflow run in the tenant's environment (Known Limitation #8); see S9 for how a dispatch can reach it.

- package.json @azure/* runtime dependencies: none
- src/ files importing @azure/*: none

## S3 (both): PASS

**Claim.** The docs-signer can write and delete documents but never read or list them.

- AWS signer S3 actions ["s3:PutObject","s3:DeleteObject"] (infra/terraform/main.tf:555): GetObject ImplicitDeny, ListBucket ImplicitDeny, PutObject (control) Allow
- AWS policies attached to the signer role: docs_signer_logs, docs_signer_s3, docs_signer_secret_read; others granting s3: none
- Azure signer role infra/terraform/azure/main.tf:521: actions ["Microsoft.Storage/storageAccounts/blobServices/generateUserDelegationKey/action"], data actions ["Microsoft.Storage/storageAccounts/blobServices/containers/blobs/write","Microsoft.Storage/storageAccounts/blobServices/containers/blobs/delete"]
- Azure role assignments to the signer identity: docs_signer_storage; using another role: none; Key Vault access policy: none

## S4 (aws): not run

- Needs a live AWS deploy; run scripts/evaluate-live.cjs cloudtrail.

## S5 (both): PASS

**Claim.** The deployment webhooks cannot be forged or replayed.

1 forged request(s) were refused by Vercel's firewall before reaching the platform, so they show the deployment is protected but do not exercise the platform's own check; src/lib/deploymentSecrets.test.ts covers those forgeries against the verifier directly.

| Endpoint | Request | HTTP | Expected | Answered by | Response |
|---|---|---|---|---|---|
| status | No secret header | 401 | 401 | platform | unauthorized |
| status | Random secret of the same length | 401 | 401 | platform | unauthorized |
| status | Real secret with its last character changed | 401 | 401 | platform | unauthorized |
| status | Real secret with one character appended | 401 | 401 | platform | unauthorized |
| status | Real secret missing its last character | 401 | 401 | platform | unauthorized |
| status | Control: real secret, unknown deployment | 404 | 404 | platform | deployment not found |
| status | Replay of a terminal callback to a finished deployment (row unchanged: true) | 409 | 409 | platform | deployment already succeeded; a finished deployment cannot be changed |
| secrets | No bearer token | 401 | 401 | platform | A GitHub Actions OIDC bearer token is required. |
| secrets | A string that is not a JWT | 401 | 401 | platform | The OIDC token is not a valid GitHub Actions token for this platform. |
| secrets | Unsigned token (alg: none) with valid-looking claims | 403 | 401 | Vercel firewall | refused by the hosting firewall |
| secrets | Token signed by a foreign RSA key under GitHub's key ID | 401 | 401 | platform | The OIDC token is not a valid GitHub Actions token for this platform. |
| secrets | Algorithm confusion: HS256 keyed with GitHub's public key | 401 | 401 | platform | The OIDC token is not a valid GitHub Actions token for this platform. |

## S6 (both): PASS

**Claim.** No secret is recoverable from the public repository or its CI logs.

- git history: 9 gitleaks findings, 9 reviewed as false positives (gitleaks-triage.json)
- Actions logs: 116 runs, 67 with retained logs (134 files, 6.6 MB, oldest 2026-08-27T00:35:05Z), unavailable by HTTP status {"410":49}; 6 gitleaks findings
- unreviewed findings: 0
- known secrets searched: 8 (DEPLOY_WEBHOOK_SECRET, GITHUB_PAT, AUTH_SECRET, AUTH_GITHUB_SECRET, PLATFORM_ENCRYPTION_KEY, tenant llm_api_key, tenant docs_signer_secret, DATABASE_URL password); exact matches: none
- Logs deleted before this run cannot be scanned; an exposure in them is outside this test.

## S7 (both): PASS

**Claim.** No secret is stored in plaintext; stored secrets are AES-256-GCM ciphertexts.

- 2 stored ciphertexts across 16 tenants; malformed: 0
- authenticate under PLATFORM_ENCRYPTION_KEY: 2/2
- reused 96-bit IVs: 0 (GCM loses confidentiality and integrity if an IV repeats under one key)
- deleted tenants still holding secrets: none
- credential-pattern matches outside the encrypted columns: none (850 cells scanned)

## S8 (both): PASS (static)

**Claim.** Only a run in the tenant's own GitHub environment can sign in to its cloud.

| Token subject | Decision | Expected |
|---|---|---|
| This tenant's environment (control) | Allow | Allow |
| Another tenant's environment | ImplicitDeny | refused |
| The deploy branch, without an environment | ImplicitDeny | refused |
| A fork naming the same environment | ImplicitDeny | refused |
| A prefix of the environment name | ImplicitDeny | refused |
| Right subject, Azure's audience | ImplicitDeny | refused |

- AWS subject condition operator: StringEquals (infra/bootstrap/aws/tenant-bootstrap.yaml:231)
- Azure subject: [format('repo:{0}/{1}:environment:tenant-{2}', parameters('gitHubOwner'), parameters('gitHubRepo'), parameters('chatbotId'))] (infra/bootstrap/azure/tenant-bootstrap.json:80); issuer and audience as expected

## S9 (both): PASS

**Claim.** Dispatching a workflow cannot make it run anything but its own steps.

Every dispatch input and step output reaches a script through env:, so its value is data to the shell and never source code. src/lib/deployPipeline.test.ts holds the same property for every workflow, so a later edit cannot reintroduce it unnoticed.

- 6 workflows: no input or step output expanded inside a run: script
- zizmor template-injection findings at high confidence: 0
- workflows granting id-token: write: deploy-tenant-azure.yml, deploy-tenant.yml, destroy-tenant-azure.yml, destroy-tenant.yml, verify-tenant-aws.yml, verify-tenant-azure.yml

## S10 (both): PASS

**Claim.** One operator cannot reach another operator's tenants through the platform.

Every action that names a tenant, deployment or document checks that the caller owns it, in the query itself.

| Case | Action | Expected | Tests | Result |
|---|---|---|---|---|
| S10.1 | Access the deployment API and tenant actions without a session | 401 or redirect | 2/2 passed | **PASS** |
| S10.2 | Request another operator's deployment with one's own session | 403 or 404 | 2/2 passed | **PASS** |
| S10.3 | Trigger destruction of another operator's tenant | Rejected | 2/2 passed | **PASS** |
| S10.4 | Request a document-upload authorization for another operator's tenant | Rejected | 2/2 passed | **PASS** |
| S10.5 | Put another operator's tenant, document or chatbot ID into a request | No cross-tenant access | 5/5 passed | **PASS** |


S10.1 live, without a session:

| Request | Path | HTTP | Redirects to | Refused |
|---|---|---|---|---|
| Deployment progress API | `/api/deployments/<random id>/progress` | 307 | /signin | yes |
| Dashboard | `/` | 307 | /signin | yes |
| A tenant page | `/tenants/<random id>` | 307 | /signin | yes |

## Infrastructure scan (Checkov)

`bridgecrew/checkov:3.3.19` over the Terraform roots, both bootstrap templates and the workflows. Checkov's open-source rules carry no severity; each failed check needs a disposition (fixed, accepted with reason, or documented limitation). Raw output: `checkov.json`.

| Framework | Passed | Failed | Parsing errors |
|---|---:|---:|---:|
| arm | 3 | 5 | 0 |
| cloudformation | 26 | 6 | 0 |
| github_actions | 332 | 12 | 0 |
| terraform | 216 | 110 | 0 |

<details><summary>/infra/bootstrap/azure/tenant-bootstrap.json: 5 failed</summary>

- `CKV_AZURE_206` Ensure that Storage Accounts use replication (Microsoft.Storage/storageAccounts.[format('cbtf{0}', replace(parameters('chatbotSlug'), '-', ''))], lines 196–217)
- `CKV_AZURE_43` Ensure Storage Accounts adhere to the naming rules (Microsoft.Storage/storageAccounts.[format('cbtf{0}', replace(parameters('chatbotSlug'), '-', ''))], lines 196–217)
- `CKV_AZURE_36` Ensure 'Trusted Microsoft Services' is enabled for Storage Account access (Microsoft.Storage/storageAccounts.[format('cbtf{0}', replace(parameters('chatbotSlug'), '-', ''))], lines 196–217)
- `CKV_AZURE_59` Ensure that Storage accounts disallow public access (Microsoft.Storage/storageAccounts.[format('cbtf{0}', replace(parameters('chatbotSlug'), '-', ''))], lines 196–217)
- `CKV_AZURE_35` Ensure default network access rule for Storage Accounts is set to deny (Microsoft.Storage/storageAccounts.[format('cbtf{0}', replace(parameters('chatbotSlug'), '-', ''))], lines 196–217)

</details>

<details><summary>/infra/bootstrap/aws/tenant-bootstrap.yaml: 6 failed</summary>

- `CKV_AWS_107` Ensure IAM policies does not allow credentials exposure (AWS::IAM::Role.DeploymentRole, lines 204–390)
- `CKV_AWS_111` Ensure IAM policies does not allow write access without constraints (AWS::IAM::Role.DeploymentRole, lines 204–390)
- `CKV_AWS_108` Ensure IAM policies does not allow data exfiltration (AWS::IAM::Role.DeploymentRole, lines 204–390)
- `CKV_AWS_110` Ensure IAM policies does not allow privilege escalation (AWS::IAM::Role.DeploymentRole, lines 204–390)
- `CKV_AWS_109` Ensure IAM policies does not allow permissions management without constraints (AWS::IAM::Role.DeploymentRole, lines 204–390)
- `CKV_AWS_18` Ensure the S3 bucket has access logging enabled (AWS::S3::Bucket.TerraformStateBucket, lines 464–500)

</details>

<details><summary>/.github/workflows/verify-tenant-aws.yml: 2 failed</summary>

- `CKV_GHA_7` The build output cannot be affected by user parameters other than the build entry point and the top-level source location. GitHub Actions workflow_dispatch inputs MUST be empty.  (on(Verify tenant connection (AWS)), lines 19–38)
- `CKV2_GHA_1` Ensure top-level permissions are not set to write-all (on(Verify tenant connection (AWS)), lines 44–45)

</details>

<details><summary>/.github/workflows/verify-tenant-azure.yml: 2 failed</summary>

- `CKV_GHA_7` The build output cannot be affected by user parameters other than the build entry point and the top-level source location. GitHub Actions workflow_dispatch inputs MUST be empty.  (on(Verify tenant connection (Azure)), lines 13–35)
- `CKV2_GHA_1` Ensure top-level permissions are not set to write-all (on(Verify tenant connection (Azure)), lines 40–41)

</details>

<details><summary>/.github/workflows/destroy-tenant-azure.yml: 2 failed</summary>

- `CKV_GHA_7` The build output cannot be affected by user parameters other than the build entry point and the top-level source location. GitHub Actions workflow_dispatch inputs MUST be empty.  (on(Destroy Tenant (Azure)), lines 13–29)
- `CKV2_GHA_1` Ensure top-level permissions are not set to write-all (on(Destroy Tenant (Azure)), lines 52–53)

</details>

<details><summary>/.github/workflows/destroy-tenant.yml: 2 failed</summary>

- `CKV_GHA_7` The build output cannot be affected by user parameters other than the build entry point and the top-level source location. GitHub Actions workflow_dispatch inputs MUST be empty.  (on(Destroy tenant chatbot), lines 7–67)
- `CKV2_GHA_1` Ensure top-level permissions are not set to write-all (on(Destroy tenant chatbot), lines 101–102)

</details>

<details><summary>/.github/workflows/deploy-tenant.yml: 2 failed</summary>

- `CKV_GHA_7` The build output cannot be affected by user parameters other than the build entry point and the top-level source location. GitHub Actions workflow_dispatch inputs MUST be empty.  (on(Deploy tenant chatbot), lines 9–96)
- `CKV2_GHA_1` Ensure top-level permissions are not set to write-all (on(Deploy tenant chatbot), lines 150–151)

</details>

<details><summary>/.github/workflows/deploy-tenant-azure.yml: 2 failed</summary>

- `CKV_GHA_7` The build output cannot be affected by user parameters other than the build entry point and the top-level source location. GitHub Actions workflow_dispatch inputs MUST be empty.  (on(Deploy Tenant (Azure)), lines 16–40)
- `CKV2_GHA_1` Ensure top-level permissions are not set to write-all (on(Deploy Tenant (Azure)), lines 87–88)

</details>

<details><summary>/infra/platform/bootstrap-templates/main.tf: 8 failed</summary>

- `CKV_AWS_56` Ensure S3 bucket has 'restrict_public_buckets' enabled (aws_s3_bucket_public_access_block.templates, lines 78–85)
- `CKV_AWS_54` Ensure S3 bucket has block public policy enabled (aws_s3_bucket_public_access_block.templates, lines 78–85)
- `CKV2_AWS_62` Ensure S3 buckets should have event notifications enabled (aws_s3_bucket.templates, lines 60–62)
- `CKV2_AWS_6` Ensure that S3 bucket has a Public Access block (aws_s3_bucket.templates, lines 60–62)
- `CKV_AWS_18` Ensure the S3 bucket has access logging enabled (aws_s3_bucket.templates, lines 60–62)
- `CKV2_AWS_61` Ensure that an S3 bucket has a lifecycle configuration (aws_s3_bucket.templates, lines 60–62)
- `CKV_AWS_144` Ensure that S3 bucket has cross-region replication enabled (aws_s3_bucket.templates, lines 60–62)
- `CKV_AWS_145` Ensure that S3 buckets are encrypted with KMS by default (aws_s3_bucket.templates, lines 60–62)

</details>

<details><summary>/infra/terraform/azure/main.tf: 44 failed</summary>

- `CKV_AZURE_163` Enable vulnerability scanning for container images. (azurerm_container_registry.this, lines 130–143)
- `CKV_AZURE_165` Ensure geo-replicated container registries to match multi-region container deployments. (azurerm_container_registry.this, lines 130–143)
- `CKV_AZURE_164` Ensures that ACR uses signed/trusted images (azurerm_container_registry.this, lines 130–143)
- `CKV_AZURE_167` Ensure a retention policy is set to cleanup untagged manifests. (azurerm_container_registry.this, lines 130–143)
- `CKV_AZURE_233` Ensure Azure Container Registry (ACR) is zone redundant (azurerm_container_registry.this, lines 130–143)
- `CKV_AZURE_139` Ensure ACR set to disable public networking (azurerm_container_registry.this, lines 130–143)
- `CKV_AZURE_166` Ensure container image quarantine, scan, and mark images verified (azurerm_container_registry.this, lines 130–143)
- `CKV_AZURE_237` Ensure dedicated data endpoints are enabled. (azurerm_container_registry.this, lines 130–143)
- `CKV_AZURE_42` Ensure the key vault is recoverable (azurerm_key_vault.this, lines 191–205)
- `CKV_AZURE_109` Ensure that key vault allows firewall rules settings (azurerm_key_vault.this, lines 191–205)
- `CKV_AZURE_110` Ensure that key vault enables purge protection (azurerm_key_vault.this, lines 191–205)
- `CKV_AZURE_189` Ensure that Azure Key Vault disables public network access (azurerm_key_vault.this, lines 191–205)
- `CKV_AZURE_114` Ensure that key vault secrets have "content_type" set (azurerm_key_vault_secret.llm_api_key, lines 207–211)
- `CKV_AZURE_41` Ensure that the expiration date is set on all secrets (azurerm_key_vault_secret.llm_api_key, lines 207–211)
- `CKV_AZURE_114` Ensure that key vault secrets have "content_type" set (azurerm_key_vault_secret.pinecone_api_key, lines 213–219)
- `CKV_AZURE_41` Ensure that the expiration date is set on all secrets (azurerm_key_vault_secret.pinecone_api_key, lines 213–219)
- `CKV_AZURE_136` Ensure that PostgreSQL Flexible server enables geo-redundant backups (azurerm_postgresql_flexible_server.vectors, lines 268–291)
- `CKV_AZURE_114` Ensure that key vault secrets have "content_type" set (azurerm_key_vault_secret.vector_db_url, lines 323–335)
- `CKV_AZURE_41` Ensure that the expiration date is set on all secrets (azurerm_key_vault_secret.vector_db_url, lines 323–335)
- `CKV_AZURE_206` Ensure that Storage Accounts use replication (azurerm_storage_account.docs, lines 341–394)
- `CKV_AZURE_33` Ensure Storage logging is enabled for Queue service for read, write and delete requests (azurerm_storage_account.docs, lines 341–394)
- `CKV_AZURE_59` Ensure that Storage accounts disallow public access (azurerm_storage_account.docs, lines 341–394)
- `CKV_AZURE_114` Ensure that key vault secrets have "content_type" set (azurerm_key_vault_secret.docs_signer, lines 424–428)
- `CKV_AZURE_41` Ensure that the expiration date is set on all secrets (azurerm_key_vault_secret.docs_signer, lines 424–428)
- `CKV_AZURE_44` Ensure Storage Account is using the latest version of TLS encryption (azurerm_storage_account.function_runtime, lines 436–452)
- `CKV_AZURE_206` Ensure that Storage Accounts use replication (azurerm_storage_account.function_runtime, lines 436–452)
- `CKV_AZURE_33` Ensure Storage logging is enabled for Queue service for read, write and delete requests (azurerm_storage_account.function_runtime, lines 436–452)
- `CKV_AZURE_59` Ensure that Storage accounts disallow public access (azurerm_storage_account.function_runtime, lines 436–452)
- `CKV_AZURE_190` Ensure that Storage blobs restrict public access (azurerm_storage_account.function_runtime, lines 436–452)
- `CKV_AZURE_225` Ensure the App Service Plan is zone redundant (azurerm_service_plan.docs_signer, lines 454–461)
- `CKV_AZURE_212` Ensure App Service has a minimum number of instances for failover (azurerm_service_plan.docs_signer, lines 454–461)
- `CKV_AZURE_221` Ensure that Azure Function App public network access is disabled (azurerm_linux_function_app.docs_signer, lines 463–509)
- `CKV2_AZURE_41` Ensure storage account is configured with SAS expiration policy (azurerm_storage_account.function_runtime, lines 436–452)
- `CKV2_AZURE_38` Ensure soft-delete is enabled on Azure storage account (azurerm_storage_account.function_runtime, lines 436–452)
- `CKV2_AZURE_57` Ensure PostgreSQL Flexible Server is configured with private endpoint (azurerm_postgresql_flexible_server.vectors, lines 268–291)
- `CKV2_AZURE_26` Ensure Azure PostgreSQL Flexible server is not configured with overly permissive network access (azurerm_postgresql_flexible_server_firewall_rule.azure_services, lines 314–321)
- `CKV2_AZURE_47` Ensure storage account is configured without blob anonymous access (azurerm_storage_account.function_runtime, lines 436–452)
- `CKV2_AZURE_40` Ensure storage account is not configured with Shared Key authorization (azurerm_storage_account.function_runtime, lines 436–452)
- `CKV2_AZURE_32` Ensure private endpoint is configured to key vault (azurerm_key_vault.this, lines 191–205)
- `CKV2_AZURE_33` Ensure storage account is configured with private endpoint (azurerm_storage_account.docs, lines 341–394)
- `CKV2_AZURE_33` Ensure storage account is configured with private endpoint (azurerm_storage_account.function_runtime, lines 436–452)
- `CKV2_AZURE_21` Ensure Storage logging is enabled for Blob service for read requests (azurerm_storage_container.docs, lines 396–400)
- `CKV2_AZURE_1` Ensure storage for critical data are encrypted with Customer Managed Key (azurerm_storage_account.docs, lines 341–394)
- `CKV2_AZURE_1` Ensure storage for critical data are encrypted with Customer Managed Key (azurerm_storage_account.function_runtime, lines 436–452)

</details>

<details><summary>/infra/terraform/main.tf: 58 failed</summary>

- `CKV_AWS_394` Ensure aws_availability_zones data source pins zone identity so its result set does not silently expand when AWS adds an Availability Zone (aws_availability_zones.available, lines 34–34)
- `CKV_AWS_130` Ensure VPC subnets do not assign public IP by default (aws_subnet.public[0], lines 99–106)
- `CKV_AWS_382` Ensure no security groups allow egress from 0.0.0.0:0 to port -1 (aws_security_group.alb, lines 127–159)
- `CKV_AWS_260` Ensure no security groups allow ingress from 0.0.0.0:0 to port 80 (aws_security_group.alb, lines 127–159)
- `CKV_AWS_23` Ensure every security group and rule has a description (aws_security_group.alb, lines 127–159)
- `CKV_AWS_382` Ensure no security groups allow egress from 0.0.0.0:0 to port -1 (aws_security_group.task, lines 161–190)
- `CKV_AWS_23` Ensure every security group and rule has a description (aws_security_group.task, lines 161–190)
- `CKV_AWS_131` Ensure that ALB drops HTTP headers (aws_lb.this, lines 196–215)
- `CKV_AWS_150` Ensure that Load Balancer has deletion protection enabled (aws_lb.this, lines 196–215)
- `CKV_AWS_91` Ensure the ELBv2 (Application/Network) has access logging enabled (aws_lb.this, lines 196–215)
- `CKV_AWS_174` Verify CloudFront Distribution Viewer Certificate is using TLS v1.2 or higher (aws_cloudfront_distribution.this, lines 353–411)
- `CKV_AWS_86` Ensure CloudFront distribution has Access Logging enabled (aws_cloudfront_distribution.this, lines 353–411)
- `CKV_AWS_310` Ensure CloudFront distributions should have origin failover configured (aws_cloudfront_distribution.this, lines 353–411)
- `CKV_AWS_305` Ensure CloudFront distribution has a default root object configured (aws_cloudfront_distribution.this, lines 353–411)
- `CKV_AWS_68` CloudFront Distribution should have WAF enabled (aws_cloudfront_distribution.this, lines 353–411)
- `CKV_AWS_374` Ensure AWS CloudFront web distribution has geo restriction enabled (aws_cloudfront_distribution.this, lines 353–411)
- `CKV_AWS_338` Ensure CloudWatch log groups retains logs for at least 1 year (aws_cloudwatch_log_group.this, lines 417–421)
- `CKV_AWS_158` Ensure that CloudWatch Log Group is encrypted by KMS (aws_cloudwatch_log_group.this, lines 417–421)
- `CKV_AWS_338` Ensure CloudWatch log groups retains logs for at least 1 year (aws_cloudwatch_log_group.docs_signer, lines 586–590)
- `CKV_AWS_158` Ensure that CloudWatch Log Group is encrypted by KMS (aws_cloudwatch_log_group.docs_signer, lines 586–590)
- `CKV_AWS_115` Ensure that AWS Lambda function is configured for function-level concurrent execution limit (aws_lambda_function.docs_signer, lines 592–614)
- `CKV_AWS_173` Check encryption settings for Lambda environmental variable (aws_lambda_function.docs_signer, lines 592–614)
- `CKV_AWS_50` X-Ray tracing is enabled for Lambda (aws_lambda_function.docs_signer, lines 592–614)
- `CKV_AWS_117` Ensure that AWS Lambda function is configured inside a VPC (aws_lambda_function.docs_signer, lines 592–614)
- `CKV_AWS_116` Ensure that AWS Lambda function is configured for a Dead Letter Queue(DLQ) (aws_lambda_function.docs_signer, lines 592–614)
- `CKV_AWS_272` Ensure AWS Lambda function is configured to validate code-signing (aws_lambda_function.docs_signer, lines 592–614)
- `CKV_AWS_258` Ensure that Lambda function URLs AuthType is not None (aws_lambda_function_url.docs_signer, lines 621–624)
- `CKV_AWS_301` Ensure that AWS Lambda function is not publicly accessible (aws_lambda_permission.docs_signer_url, lines 649–655)
- `CKV_AWS_23` Ensure every security group and rule has a description (aws_security_group.vectors, lines 688–703)
- `CKV_AWS_118` Ensure that enhanced monitoring is enabled for Amazon RDS instances (aws_db_instance.vectors, lines 736–763)
- `CKV_AWS_293` Ensure that AWS database instances have deletion protection enabled (aws_db_instance.vectors, lines 736–763)
- `CKV_AWS_161` Ensure RDS database has IAM authentication enabled (aws_db_instance.vectors, lines 736–763)
- `CKV_AWS_353` Ensure that RDS instances have performance insights enabled (aws_db_instance.vectors, lines 736–763)
- `CKV_AWS_226` Ensure DB instance gets all minor upgrades automatically (aws_db_instance.vectors, lines 736–763)
- `CKV_AWS_157` Ensure that RDS instances have Multi-AZ enabled (aws_db_instance.vectors, lines 736–763)
- `CKV_AWS_129` Ensure that respective logs of Amazon Relational Database Service (Amazon RDS) are enabled (aws_db_instance.vectors, lines 736–763)
- `CKV_AWS_149` Ensure that Secrets Manager secret is encrypted using KMS CMK (aws_secretsmanager_secret.vectors, lines 767–773)
- `CKV_AWS_65` Ensure container insights are enabled on ECS cluster (aws_ecs_cluster.this, lines 862–865)
- `CKV_AWS_333` Ensure ECS services do not have public IP addresses assigned to them automatically (aws_ecs_service.this, lines 935–1000)
- `CKV_AWS_333` Ensure ECS services do not have public IP addresses assigned to them automatically (aws_ecs_service.frontend, lines 1036–1069)
- `CKV_AWS_130` Ensure VPC subnets do not assign public IP by default (aws_subnet.public[1], lines 99–106)
- `CKV2_AWS_12` Ensure the default security group of every VPC restricts all traffic (aws_vpc.this, lines 87–92)
- `CKV2_AWS_30` Ensure Postgres RDS as aws_db_instance has Query Logging enabled (aws_db_instance.vectors, lines 736–763)
- `CKV2_AWS_62` Ensure S3 buckets should have event notifications enabled (aws_s3_bucket.docs, lines 427–437)
- `CKV2_AWS_11` Ensure VPC flow logging is enabled in all VPCs (aws_vpc.this, lines 87–92)
- `CKV2_AWS_42` Ensure AWS CloudFront distribution uses custom SSL certificate (aws_cloudfront_distribution.this, lines 353–411)
- `CKV2_AWS_32` Ensure CloudFront distribution has a response headers policy attached (aws_cloudfront_distribution.this, lines 353–411)
- `CKV2_AWS_20` Ensure that ALB redirects HTTP requests into HTTPS ones (aws_lb.this, lines 196–215)
- `CKV2_AWS_47` Ensure AWS CloudFront attached WAFv2 WebACL is configured with AMR for Log4j Vulnerability (aws_cloudfront_distribution.this, lines 353–411)
- `CKV2_AWS_60` Ensure RDS instance with copy tags to snapshots is enabled (aws_db_instance.vectors, lines 736–763)
- `CKV_AWS_18` Ensure the S3 bucket has access logging enabled (aws_s3_bucket.docs, lines 427–437)
- `CKV_AWS_103` Ensure that load balancer is using at least TLS 1.2 (aws_lb_listener.http, lines 260–284)
- `CKV_AWS_378` Ensure AWS Load Balancer doesn't use HTTP protocol (aws_lb_target_group.this, lines 218–235)
- `CKV_AWS_378` Ensure AWS Load Balancer doesn't use HTTP protocol (aws_lb_target_group.frontend, lines 238–255)
- `CKV2_AWS_57` Ensure Secrets Manager secrets should have automatic rotation enabled (aws_secretsmanager_secret.vectors, lines 767–773)
- `CKV2_AWS_28` Ensure public facing ALB are protected by WAF (aws_lb.this, lines 196–215)
- `CKV_AWS_144` Ensure that S3 bucket has cross-region replication enabled (aws_s3_bucket.docs, lines 427–437)
- `CKV_AWS_145` Ensure that S3 buckets are encrypted with KMS by default (aws_s3_bucket.docs, lines 427–437)

</details>

## Workflow scan (zizmor)

`ghcr.io/zizmorcore/zizmor:1.30.1`, offline audits. Raw output: `zizmor.json`.

| Severity | Audit | Confidence | Findings |
|---|---|---|---:|

