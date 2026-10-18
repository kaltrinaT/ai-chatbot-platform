# Security evaluation — local end-to-end

Generated 2026-10-18T01:32:28.782Z by `npm run evaluate:security:e2e` at commit `61de49007640` with uncommitted changes. Node v24.16.0, Windows_NT 10.0.26300 (win32), PGlite 0.5.8.

> **Scope.** No AWS or Azure resource was created and nothing was sent to GitHub. These are automated integration and simulation tests: the application runs against a real, in-process Postgres; cloud permissions are evaluated from the templates and Terraform that create them; workflow steps run in local bash with cloud CLIs stubbed. They show what the code and policies as written decide, not what a live cloud did.

**Overall: PASS.** 6 fixture secrets were searched for in the evidence, together with 8 credential patterns: none found.

| ID | Lane | Demonstration | Result | Attacks refused | Controls succeeded | Tests |
|---|---|---|---|---|---|---|
| SEC-E2E-01 | Application | Cross-tenant authorization | **PASS** | 20/20 | 8/8 | 22/22 |
| SEC-E2E-02 | Cloud identity | Document-access denial | **PASS** | 8/8 | 4/4 | 10/10 |
| SEC-E2E-03 | Cloud identity | Cloud identity isolation | **PASS** | 44/44 | 7/7 | 51/51 |
| SEC-E2E-04 | GitHub workflow | Workflow integrity | **PASS** | 79/79 | 7/7 | 81/81 |

## SEC-E2E-01 — Cross-tenant authorization: PASS

**Claim.** An operator can act on their own tenants and on nothing else; a deployment webhook changes a deployment only forward and only once.

**Method.** The real server actions, API routes and deploy logic against a migrated Postgres (PGlite). Only the session, GitHub dispatch and the tenant's signer and backend are replaced, each recording what it was asked to do; the database is read back after every operation.

| | Operation | Required | Observed | Held |
|---|---|---|---|---|
| attack | Alice redeploys Bob's tenant | refused; no deployment row for B; nothing dispatched | `{"result":{"ok":false,"error":"Error: Tenant not found"},"deploymentsBefore":1,"deploymentsAfter":1,"dispatches":0,"presigned":[],"signerDeletes":0,"reindexed":[]}` | ✓ |
| control | Alice redeploys her own tenant | dispatched; a running deployment row for A | `{"result":true,"deployments":[{"kind":"deploy","status":"succeeded"},{"kind":"deploy","status":"running"}],"dispatchedFor":["a0000000-0000-4000-8000-00000000000a"]}` | ✓ |
| attack | Alice tears down Bob's tenant | refused; B not deleted; no destroy row; B's documents untouched | `{"result":{"ok":false,"error":"Error: Tenant not found"},"after":{"deleted":false,"deployments":[{"kind":"deploy","status":"succeeded"}],"documents":[{"id":"cb000000-0000-4000-8000-0000000000cb","status":"uploaded"}]}…` | ✓ |
| control | Alice tears down her own tenant | a destroy deployment for A is dispatched, A's documents emptied through A's signer | `{"result":true,"deployments":[{"kind":"deploy","status":"succeeded"},{"kind":"destroy","status":"running"}],"signerDeletes":[{"tenantId":"a0000000-0000-4000-8000-00000000000a","objectKey":"a0000000-0000-4000-8000-0000…` | ✓ |
| attack | Alice reads Bob's deployment through the API | 404, and nothing of B's in the body | `{"status":404,"mentionsB":false}` | ✓ |
| control | Alice reads her own deployment | 200 with the deployment | `{"status":200}` | ✓ |
| attack | Alice requests an upload URL for Bob's tenant | refused before B's signer is called; no document row added | `{"result":{"ok":false,"error":"Tenant not found."},"documents":1,"presigned":[]}` | ✓ |
| control | Alice requests an upload URL for her own tenant | A's signer presigns, a pending row is added to A | `{"ok":true,"presigned":["a0000000-0000-4000-8000-00000000000a"],"documents":["pending","uploaded"]}` | ✓ |
| attack | Alice deletes, confirms and abandons Bob's document | all refused; B's document row unchanged; B's signer and backend not called | `{"results":{"delete":{"ok":false,"error":"Error: Tenant not found"},"confirm":{"ok":false,"error":"Error: Tenant not found"},"abandon":{"ok":false,"error":"Error: Tenant not found"}},"documentsBefore":[{"id":"cb000000…` | ✓ |
| control | Alice deletes her own document | deleted through A's signer, row removed, A reindexed | `{"result":true,"documents":0,"signerDeletes":[{"tenantId":"a0000000-0000-4000-8000-00000000000a","objectKey":"a0000000-0000-4000-8000-00000000000a/handbook.pdf"}],"reindexed":["alpha"]}` | ✓ |
| attack | Alice names missing as the tenant | refused; nothing dispatched or presigned; B unchanged | `{"redeploy":{"ok":false,"error":"database refused: invalid input syntax for type uuid: \"\""},"upload":{"ok":false,"error":"database refused: invalid input syntax for type uuid: \"\""},"dispatches":0,"presigned":[],"s…` | ✓ |
| attack | Alice names a guessed UUID as the tenant | refused; nothing dispatched or presigned; B unchanged | `{"redeploy":{"ok":false,"error":"Error: Tenant not found"},"upload":{"ok":true,"value":{"ok":false,"error":"Tenant not found."}},"dispatches":0,"presigned":[],"signerDeletes":0,"reindexed":[],"bDeployments":1}` | ✓ |
| attack | Alice names Bob's ID upper-cased as the tenant | refused; nothing dispatched or presigned; B unchanged | `{"redeploy":{"ok":false,"error":"Error: Tenant not found"},"upload":{"ok":true,"value":{"ok":false,"error":"Tenant not found."}},"dispatches":0,"presigned":[],"signerDeletes":0,"reindexed":[],"bDeployments":1}` | ✓ |
| attack | Alice names a SQL fragment as the tenant | refused; nothing dispatched or presigned; B unchanged | `{"redeploy":{"ok":false,"error":"database refused: invalid input syntax for type uuid: \"' OR '1'='1\""},"upload":{"ok":false,"error":"database refused: invalid input syntax for type uuid: \"' OR '1'='1\""},"dispatche…` | ✓ |
| attack | Alice names Bob's ID with a trailing comment as the tenant | refused; nothing dispatched or presigned; B unchanged | `{"redeploy":{"ok":false,"error":"database refused: invalid input syntax for type uuid: \"b0000000-0000-4000-8000-00000000000b' --\""},"upload":{"ok":false,"error":"database refused: invalid input syntax for type uuid:…` | ✓ |
| control | Alice names her own tenant's ID upper-cased | dispatched for A | `{"result":true,"dispatchedFor":["a0000000-0000-4000-8000-00000000000a"]}` | ✓ |
| attack | Alice redeploys, tears down and uploads to her deleted tenant | all refused; no deployment or document row added | `{"attempts":{"redeploy":{"ok":false,"error":"Error: Tenant not found"},"teardown":{"ok":false,"error":"Error: Tenant not found"},"upload":{"ok":true,"value":{"ok":false,"error":"Tenant not found."}}},"before":{"delete…` | ✓ |
| attack | Two redeploys of one tenant at once | one dispatched, one refused as in progress; one active row | `{"results":[{"ok":true},{"ok":false,"error":"DeploymentInProgressError: A deployment for tenant a0000000-0000-4000-8000-00000000000a is already in progress. Wait for it to finish before starting another."}],"active":1…` | ✓ |
| attack | A redeploy and a teardown of one tenant at once | exactly one runs; Terraform state is never driven by two runs | `{"results":[{"ok":true},{"ok":false,"error":"DeploymentInProgressError: A deployment for tenant a0000000-0000-4000-8000-00000000000a is already in progress. Wait for it to finish before starting another."}],"active":[…` | ✓ |
| attack | Five concurrent redeploys of Bob's tenant by Alice | all refused; no row for B | `{"refused":5,"bDeployments":1,"dispatches":0}` | ✓ |
| control | Alice and Bob redeploy their own tenants at once | both dispatched, each for its own tenant | `{"alice":true,"bob":true,"dispatched":["a0000000-0000-4000-8000-00000000000a","b0000000-0000-4000-8000-00000000000b"]}` | ✓ |
| control | The run's own success callback | 200; deployment succeeded | `{"status":200,"row":"succeeded"}` | ✓ |
| attack | The callback replayed, rewritten as a failure | 409; the row is byte-for-byte unchanged | `{"status":409,"before":{"status":"succeeded","finished_at":"2026-10-18T01:28:45.802Z","error_message":null},"after":{"status":"succeeded","finished_at":"2026-10-18T01:28:45.802Z","error_message":null}}` | ✓ |
| attack | Two terminal callbacks for one deployment at once | one 200 and one 409; the row holds the winner's status only | `{"statuses":[200,409],"final":{"status":"succeeded","finished_at":"2026-10-18T01:28:45.836Z","error_message":null}}` | ✓ |
| attack | Webhook: moving back to pending | 400; row unchanged | `{"status":400,"before":{"status":"running","finished_at":null,"error_message":null},"after":{"status":"running","finished_at":null,"error_message":null}}` | ✓ |
| attack | Webhook: a malformed body | 400; row unchanged | `{"status":400,"before":{"status":"running","finished_at":null,"error_message":null},"after":{"status":"running","finished_at":null,"error_message":null}}` | ✓ |
| attack | Webhook: an unknown status | 400; row unchanged | `{"status":400,"before":{"status":"running","finished_at":null,"error_message":null},"after":{"status":"running","finished_at":null,"error_message":null}}` | ✓ |
| attack | Webhook with a near-miss secret, then one redirecting the docs-signer | 401, then 400; the tenant's signer URL unchanged | `{"forged":401,"hijack":400,"signerUrl":"https://alpha.lambda-url.eu-central-1.on.aws/","row":{"status":"running","finished_at":null,"error_message":null}}` | ✓ |

## SEC-E2E-02 — Document-access denial: PASS

**Claim.** Neither the control plane nor the docs-signer can read or list a tenant's documents; the signer can only write and delete.

**Method.** Simulated: AWS policies from the bootstrap template, the tenant Terraform and the control-plane Terraform, evaluated by the IAM model shared with evaluate-security.cjs; Azure role actions from the tenant Terraform.

| | Operation | Required | Observed | Held |
|---|---|---|---|---|
| attack | Platform role → chatbot-client-deploy-alpha → s3:GetObject / s3:ListBucket | at least one link of the path refused | `{"mayAssume":"ImplicitDeny","trustsPlatform":"ImplicitDeny","read":"Allow","list":"Allow"}` | ✓ |
| attack | Platform role → chatbot-client-onboard-alpha → s3:GetObject / s3:ListBucket | at least one link of the path refused | `{"mayAssume":"Allow","trustsPlatform":"Allow","read":"ImplicitDeny","list":"ImplicitDeny"}` | ✓ |
| attack | Platform role calls s3:GetObject and s3:ListBucket itself | both refused | `{"read":"ImplicitDeny","list":"ImplicitDeny","policy":"infra/platform/control-plane/main.tf"}` | ✓ |
| attack | Onboarding role reads its secret back, writes alpha-corp's, reads a document | all refused | `{"getSecretValue":"ImplicitDeny","writeNeighbour":"ImplicitDeny","readDocument":"ImplicitDeny"}` | ✓ |
| control | Platform assumes the onboarding role and stores this tenant's secret | both allowed | `{"assume":"Allow","create":"Allow"}` | ✓ |
| control | Deployment role (GitHub only) reads a document | allowed — this role builds the bucket, and the platform cannot assume it | `{"read":"Allow","statements":["Storage"]}` | ✓ |
| attack | Hand-applied onboarding policy: s3:GetObject and GetSecretValue | both refused | `{"read":"ImplicitDeny","getSecretValue":"ImplicitDeny"}` | ✓ |
| attack | AWS signer reads, lists, and writes another tenant's bucket | all refused | `{"read":"ImplicitDeny","list":"ImplicitDeny","otherBucket":"ImplicitDeny"}` | ✓ |
| control | AWS signer writes and deletes in its own bucket | both allowed | `{"put":"Allow","delete":"Allow"}` | ✓ |
| attack | Azure signer reads a blob, lists a container, reads a vault secret, lists account keys | none granted | `{"readBlob":false,"listContainer":false,"readKeyVaultSecret":false,"listAccountKeys":false,"dataActions":["Microsoft.Storage/storageAccounts/blobServices/containers/blobs/write","Microsoft.Storage/storageAccounts/blob…` | ✓ |
| control | Azure signer writes and deletes a blob | both granted | `{"write":true,"delete":true}` | ✓ |
| attack | Control plane carries a storage client or an Azure credential | none | `{"runtimeStorageClients":[],"azureCredentialColumns":[]}` | ✓ |

## SEC-E2E-03 — Cloud identity isolation: PASS

**Claim.** A run for tenant A can sign in to A's cloud and fetch A's secrets, and cannot do either for tenant B.

**Method.** Simulated STS and Entra ID decisions against the bootstrap templates, with forged token claims; the platform's own secrets release run for real against PGlite with AES-GCM ciphertexts and locally signed RS256 tokens.

| | Operation | Required | Observed | Held |
|---|---|---|---|---|
| control | AWS (bootstrap template): A's run assumes A's deployment role | Allow | `{"decision":"Allow","statements":["GitHubActionsDeploy"]}` | ✓ |
| attack | AWS (bootstrap template): token from tenant B's environment | refused | `{"sub":"repo:acme/platform:environment:tenant-b0000000-0000-4000-8000-00000000000b","aud":"sts.amazonaws.com","decision":"ImplicitDeny"}` | ✓ |
| attack | AWS (bootstrap template): token from the deploy branch, no environment | refused | `{"sub":"repo:acme/platform:ref:refs/heads/main","aud":"sts.amazonaws.com","decision":"ImplicitDeny"}` | ✓ |
| attack | AWS (bootstrap template): token from a pull request | refused | `{"sub":"repo:acme/platform:pull_request","aud":"sts.amazonaws.com","decision":"ImplicitDeny"}` | ✓ |
| attack | AWS (bootstrap template): token from a fork naming A's environment | refused | `{"sub":"repo:mallory/platform:environment:tenant-a0000000-0000-4000-8000-00000000000a","aud":"sts.amazonaws.com","decision":"ImplicitDeny"}` | ✓ |
| attack | AWS (bootstrap template): token from a prefix of A's environment | refused | `{"sub":"repo:acme/platform:environment:tenant-a0000000-0000-4000-8000-00000000","aud":"sts.amazonaws.com","decision":"ImplicitDeny"}` | ✓ |
| attack | AWS (bootstrap template): token from A's environment upper-cased | refused | `{"sub":"REPO:ACME/PLATFORM:ENVIRONMENT:TENANT-A0000000-0000-4000-8000-00000000000A","aud":"sts.amazonaws.com","decision":"ImplicitDeny"}` | ✓ |
| attack | AWS (bootstrap template): token from Azure's audience | refused | `{"sub":"repo:acme/platform:environment:tenant-a0000000-0000-4000-8000-00000000000a","aud":"api://AzureADTokenExchange","decision":"ImplicitDeny"}` | ✓ |
| attack | AWS (bootstrap template): token from the platform's own audience | refused | `{"sub":"repo:acme/platform:environment:tenant-a0000000-0000-4000-8000-00000000000a","aud":"ai-chatbot-platform:tenant-secrets","decision":"ImplicitDeny"}` | ✓ |
| attack | AWS (bootstrap template): token from another identity provider (issuer) | refused | `{"sub":"repo:acme/platform:environment:tenant-a0000000-0000-4000-8000-00000000000a","aud":"sts.amazonaws.com","decision":"ImplicitDeny"}` | ✓ |
| attack | AWS (bootstrap template): the platform assumes the deployment role | refused — this role trusts GitHub only | `{"decision":"ImplicitDeny","statements":[]}` | ✓ |
| control | AWS (policy the wizard shows): A's run assumes A's deployment role | Allow | `{"decision":"Allow","statements":["GitHubActionsDeploy"]}` | ✓ |
| attack | AWS (policy the wizard shows): token from tenant B's environment | refused | `{"sub":"repo:acme/platform:environment:tenant-b0000000-0000-4000-8000-00000000000b","aud":"sts.amazonaws.com","decision":"ImplicitDeny"}` | ✓ |
| attack | AWS (policy the wizard shows): token from the deploy branch, no environment | refused | `{"sub":"repo:acme/platform:ref:refs/heads/main","aud":"sts.amazonaws.com","decision":"ImplicitDeny"}` | ✓ |
| attack | AWS (policy the wizard shows): token from a pull request | refused | `{"sub":"repo:acme/platform:pull_request","aud":"sts.amazonaws.com","decision":"ImplicitDeny"}` | ✓ |
| attack | AWS (policy the wizard shows): token from a fork naming A's environment | refused | `{"sub":"repo:mallory/platform:environment:tenant-a0000000-0000-4000-8000-00000000000a","aud":"sts.amazonaws.com","decision":"ImplicitDeny"}` | ✓ |
| attack | AWS (policy the wizard shows): token from a prefix of A's environment | refused | `{"sub":"repo:acme/platform:environment:tenant-a0000000-0000-4000-8000-00000000","aud":"sts.amazonaws.com","decision":"ImplicitDeny"}` | ✓ |
| attack | AWS (policy the wizard shows): token from A's environment upper-cased | refused | `{"sub":"REPO:ACME/PLATFORM:ENVIRONMENT:TENANT-A0000000-0000-4000-8000-00000000000A","aud":"sts.amazonaws.com","decision":"ImplicitDeny"}` | ✓ |
| attack | AWS (policy the wizard shows): token from Azure's audience | refused | `{"sub":"repo:acme/platform:environment:tenant-a0000000-0000-4000-8000-00000000000a","aud":"api://AzureADTokenExchange","decision":"ImplicitDeny"}` | ✓ |
| attack | AWS (policy the wizard shows): token from the platform's own audience | refused | `{"sub":"repo:acme/platform:environment:tenant-a0000000-0000-4000-8000-00000000000a","aud":"ai-chatbot-platform:tenant-secrets","decision":"ImplicitDeny"}` | ✓ |
| attack | AWS (policy the wizard shows): token from another identity provider (issuer) | refused | `{"sub":"repo:acme/platform:environment:tenant-a0000000-0000-4000-8000-00000000000a","aud":"sts.amazonaws.com","decision":"ImplicitDeny"}` | ✓ |
| attack | AWS (policy the wizard shows): the platform assumes the deployment role | refused — this role trusts GitHub only | `{"decision":"ImplicitDeny","statements":[]}` | ✓ |
| control | AWS onboarding (bootstrap template): platform with A's ExternalId | Allow | `{"decision":"Allow","statements":["PlatformOnboarding"]}` | ✓ |
| attack | AWS onboarding (bootstrap template): tenant B's ExternalId | refused | `{"decision":"ImplicitDeny","statements":[]}` | ✓ |
| attack | AWS onboarding (bootstrap template): no ExternalId | refused | `{"decision":"ImplicitDeny","statements":[]}` | ✓ |
| attack | AWS onboarding (bootstrap template): A's ExternalId upper-cased | refused | `{"decision":"ImplicitDeny","statements":[]}` | ✓ |
| attack | AWS onboarding (bootstrap template): A's ExternalId with a suffix | refused | `{"decision":"ImplicitDeny","statements":[]}` | ✓ |
| attack | AWS onboarding (bootstrap template): A's ExternalId, from another AWS account | refused | `{"decision":"ImplicitDeny","statements":[]}` | ✓ |
| control | AWS onboarding (policy the wizard shows): platform with A's ExternalId | Allow | `{"decision":"Allow","statements":["PlatformOnboarding"]}` | ✓ |
| attack | AWS onboarding (policy the wizard shows): tenant B's ExternalId | refused | `{"decision":"ImplicitDeny","statements":[]}` | ✓ |
| attack | AWS onboarding (policy the wizard shows): no ExternalId | refused | `{"decision":"ImplicitDeny","statements":[]}` | ✓ |
| attack | AWS onboarding (policy the wizard shows): A's ExternalId upper-cased | refused | `{"decision":"ImplicitDeny","statements":[]}` | ✓ |
| attack | AWS onboarding (policy the wizard shows): A's ExternalId with a suffix | refused | `{"decision":"ImplicitDeny","statements":[]}` | ✓ |
| attack | AWS onboarding (policy the wizard shows): A's ExternalId, from another AWS account | refused | `{"decision":"ImplicitDeny","statements":[]}` | ✓ |
| control | Azure: A's run exchanges its token with A's federated credential | accepted; template subject equals azureFederatedSubject() | `{"subject":"repo:acme/platform:environment:tenant-a0000000-0000-4000-8000-00000000000a","matchesApp":true,"wiredThrough":true,"accepted":true}` | ✓ |
| attack | Azure: token from tenant B's environment | refused | `{"iss":"https://token.actions.githubusercontent.com","sub":"repo:acme/platform:environment:tenant-b0000000-0000-4000-8000-00000000000b","aud":"api://AzureADTokenExchange","accepted":false}` | ✓ |
| attack | Azure: token from the deploy branch | refused | `{"iss":"https://token.actions.githubusercontent.com","sub":"repo:acme/platform:ref:refs/heads/main","aud":"api://AzureADTokenExchange","accepted":false}` | ✓ |
| attack | Azure: token from a fork naming A's environment | refused | `{"iss":"https://token.actions.githubusercontent.com","sub":"repo:mallory/platform:environment:tenant-a0000000-0000-4000-8000-00000000000a","aud":"api://AzureADTokenExchange","accepted":false}` | ✓ |
| attack | Azure: token from AWS's audience | refused | `{"iss":"https://token.actions.githubusercontent.com","sub":"repo:acme/platform:environment:tenant-a0000000-0000-4000-8000-00000000000a","aud":"sts.amazonaws.com","accepted":false}` | ✓ |
| attack | Azure: token from the platform's own audience | refused | `{"iss":"https://token.actions.githubusercontent.com","sub":"repo:acme/platform:environment:tenant-a0000000-0000-4000-8000-00000000000a","aud":"ai-chatbot-platform:tenant-secrets","accepted":false}` | ✓ |
| attack | Azure: token from a lookalike issuer | refused | `{"iss":"https://token.actions.githubusercontent.com.attacker.example","sub":"repo:acme/platform:environment:tenant-a0000000-0000-4000-8000-00000000000a","aud":"api://AzureADTokenExchange","accepted":false}` | ✓ |
| attack | Azure: token from an issuer with a trailing slash | refused | `{"iss":"https://token.actions.githubusercontent.com/","sub":"repo:acme/platform:environment:tenant-a0000000-0000-4000-8000-00000000000a","aud":"api://AzureADTokenExchange","accepted":false}` | ✓ |
| control | A's deploy run asks for A's deployment secrets | released (decrypted correctly), claim recorded with the run ID | `{"released":["docsSignerSecret","llmApiKey","pineconeApiKey"],"decryptedCorrectly":true,"claimed":true,"runId":"1001"}` | ✓ |
| attack | Secrets: B's run, for A's deployment | refused; secrets_claimed_at still null | `{"result":{"ok":false,"error":"SecretsRequestError: The token's subject is not this deployment's tenant environment."},"claimed":false}` | ✓ |
| attack | Secrets: A's run, for B's deployment | refused; secrets_claimed_at still null | `{"result":{"ok":false,"error":"SecretsRequestError: The token's subject is not this deployment's tenant environment."},"claimed":false}` | ✓ |
| attack | Secrets: the connection check in A's environment | refused; secrets_claimed_at still null | `{"result":{"ok":false,"error":"SecretsRequestError: Only deploy-tenant-azure.yml on the deploy ref may fetch these secrets."},"claimed":false}` | ✓ |
| attack | Secrets: A's workflow from a feature branch | refused; secrets_claimed_at still null | `{"result":{"ok":false,"error":"SecretsRequestError: Only deploy-tenant-azure.yml on the deploy ref may fetch these secrets."},"claimed":false}` | ✓ |
| attack | Secrets: a fork's run naming A's environment | refused; secrets_claimed_at still null | `{"result":{"ok":false,"error":"SecretsRequestError: The token was not issued to the platform's deploy repository."},"claimed":false}` | ✓ |
| attack | Secrets: a second run, then the first run again, after the claim | both refused with 409 | `{"other":"SecretsRequestError: This deployment's secrets were already released, it has finished, or it belongs to another run. Start a new deployment from the platform.","replay":"SecretsRequestError: This deployment'…` | ✓ |
| attack | Secrets: two runs claim one deployment at once | one served, one refused; the row names the winner's run | `{"served":1,"runId":"3003"}` | ✓ |
| control | B's deploy run asks for B's deployment secrets | released, decrypted to B's key and not A's | `{"released":["docsSignerSecret","llmApiKey","pineconeApiKey"],"decryptedCorrectly":true}` | ✓ |

## SEC-E2E-04 — Workflow integrity: PASS

**Claim.** Dispatch inputs are only data: they cannot run a command or rewrite another step's output.

**Method.** The workflows' own step scripts executed in local bash with GitHub's flags and $GITHUB_OUTPUT semantics; aws, docker, az, terraform and curl stubbed to record their arguments; a canary file detects code execution.

| | Operation | Required | Observed | Held |
|---|---|---|---|---|
| control | Azure deploy with a well-formed config | both steps succeed; outputs carry the config's values | `{"cfg":{"exitCode":0,"outputLines":10,"canaryCreated":false},"region":"swedencentral","imageUri":"chatbotalpha.azurecr.io/chatbot-backend:latest"}` | ✓ |
| attack | config.azure_region = command substitution | no command runs; the value reaches the output byte for byte | `{"exitCode":0,"outputLines":10,"canaryCreated":false,"valueIntact":true,"namesExit":0}` | ✓ |
| attack | config.azure_region = backticks | no command runs; the value reaches the output byte for byte | `{"exitCode":0,"outputLines":10,"canaryCreated":false,"valueIntact":true,"namesExit":0}` | ✓ |
| attack | config.azure_region = breaking out of double quotes | no command runs; the value reaches the output byte for byte | `{"exitCode":0,"outputLines":10,"canaryCreated":false,"valueIntact":true,"namesExit":0}` | ✓ |
| attack | config.azure_region = breaking out of single quotes | no command runs; the value reaches the output byte for byte | `{"exitCode":0,"outputLines":10,"canaryCreated":false,"valueIntact":true,"namesExit":0}` | ✓ |
| attack | config.azure_region = a command list | no command runs; the value reaches the output byte for byte | `{"exitCode":0,"outputLines":10,"canaryCreated":false,"valueIntact":true,"namesExit":0}` | ✓ |
| attack | config.azure_region = a pipe | no command runs; the value reaches the output byte for byte | `{"exitCode":0,"outputLines":10,"canaryCreated":false,"valueIntact":true,"namesExit":0}` | ✓ |
| attack | config.azure_region = IFS word splitting | no command runs; the value reaches the output byte for byte | `{"exitCode":0,"outputLines":10,"canaryCreated":false,"valueIntact":true,"namesExit":0}` | ✓ |
| attack | config.llm_model = command substitution | no command runs; the value reaches the output byte for byte | `{"exitCode":0,"outputLines":10,"canaryCreated":false,"valueIntact":true,"namesExit":0}` | ✓ |
| attack | config.llm_model = backticks | no command runs; the value reaches the output byte for byte | `{"exitCode":0,"outputLines":10,"canaryCreated":false,"valueIntact":true,"namesExit":0}` | ✓ |
| attack | config.llm_model = breaking out of double quotes | no command runs; the value reaches the output byte for byte | `{"exitCode":0,"outputLines":10,"canaryCreated":false,"valueIntact":true,"namesExit":0}` | ✓ |
| attack | config.llm_model = breaking out of single quotes | no command runs; the value reaches the output byte for byte | `{"exitCode":0,"outputLines":10,"canaryCreated":false,"valueIntact":true,"namesExit":0}` | ✓ |
| attack | config.llm_model = a command list | no command runs; the value reaches the output byte for byte | `{"exitCode":0,"outputLines":10,"canaryCreated":false,"valueIntact":true,"namesExit":0}` | ✓ |
| attack | config.llm_model = a pipe | no command runs; the value reaches the output byte for byte | `{"exitCode":0,"outputLines":10,"canaryCreated":false,"valueIntact":true,"namesExit":0}` | ✓ |
| attack | config.llm_model = IFS word splitting | no command runs; the value reaches the output byte for byte | `{"exitCode":0,"outputLines":10,"canaryCreated":false,"valueIntact":true,"namesExit":0}` | ✓ |
| attack | config.chatbot_version = command substitution | no command runs; the value reaches the output byte for byte | `{"exitCode":0,"outputLines":10,"canaryCreated":false,"valueIntact":true,"namesExit":0}` | ✓ |
| attack | config.chatbot_version = backticks | no command runs; the value reaches the output byte for byte | `{"exitCode":0,"outputLines":10,"canaryCreated":false,"valueIntact":true,"namesExit":0}` | ✓ |
| attack | config.chatbot_version = breaking out of double quotes | no command runs; the value reaches the output byte for byte | `{"exitCode":0,"outputLines":10,"canaryCreated":false,"valueIntact":true,"namesExit":0}` | ✓ |
| attack | config.chatbot_version = breaking out of single quotes | no command runs; the value reaches the output byte for byte | `{"exitCode":0,"outputLines":10,"canaryCreated":false,"valueIntact":true,"namesExit":0}` | ✓ |
| attack | config.chatbot_version = a command list | no command runs; the value reaches the output byte for byte | `{"exitCode":0,"outputLines":10,"canaryCreated":false,"valueIntact":true,"namesExit":0}` | ✓ |
| attack | config.chatbot_version = a pipe | no command runs; the value reaches the output byte for byte | `{"exitCode":0,"outputLines":10,"canaryCreated":false,"valueIntact":true,"namesExit":0}` | ✓ |
| attack | config.chatbot_version = IFS word splitting | no command runs; the value reaches the output byte for byte | `{"exitCode":0,"outputLines":10,"canaryCreated":false,"valueIntact":true,"namesExit":0}` | ✓ |
| attack | config.domain = command substitution | no command runs; the value reaches the output byte for byte | `{"exitCode":0,"outputLines":10,"canaryCreated":false,"valueIntact":true,"namesExit":0}` | ✓ |
| attack | config.domain = backticks | no command runs; the value reaches the output byte for byte | `{"exitCode":0,"outputLines":10,"canaryCreated":false,"valueIntact":true,"namesExit":0}` | ✓ |
| attack | config.domain = breaking out of double quotes | no command runs; the value reaches the output byte for byte | `{"exitCode":0,"outputLines":10,"canaryCreated":false,"valueIntact":true,"namesExit":0}` | ✓ |
| attack | config.domain = breaking out of single quotes | no command runs; the value reaches the output byte for byte | `{"exitCode":0,"outputLines":10,"canaryCreated":false,"valueIntact":true,"namesExit":0}` | ✓ |
| attack | config.domain = a command list | no command runs; the value reaches the output byte for byte | `{"exitCode":0,"outputLines":10,"canaryCreated":false,"valueIntact":true,"namesExit":0}` | ✓ |
| attack | config.domain = a pipe | no command runs; the value reaches the output byte for byte | `{"exitCode":0,"outputLines":10,"canaryCreated":false,"valueIntact":true,"namesExit":0}` | ✓ |
| attack | config.domain = IFS word splitting | no command runs; the value reaches the output byte for byte | `{"exitCode":0,"outputLines":10,"canaryCreated":false,"valueIntact":true,"namesExit":0}` | ✓ |
| attack | config.azure_region carries a new line overriding the subscription | the step fails and writes no output | `{"exitCode":1,"outputLines":0,"canaryCreated":false,"subscription":null}` | ✓ |
| attack | config.azure_region carries a carriage return | the step fails and writes no output | `{"exitCode":1,"outputLines":0,"canaryCreated":false,"subscription":null}` | ✓ |
| attack | config.azure_region carries a heredoc opener | the step fails and writes no output | `{"exitCode":1,"outputLines":0,"canaryCreated":false,"subscription":null}` | ✓ |
| attack | config.llm_model carries a new line overriding the subscription | the step fails and writes no output | `{"exitCode":1,"outputLines":0,"canaryCreated":false,"subscription":null}` | ✓ |
| attack | config.llm_model carries a carriage return | the step fails and writes no output | `{"exitCode":1,"outputLines":0,"canaryCreated":false,"subscription":null}` | ✓ |
| attack | config.llm_model carries a heredoc opener | the step fails and writes no output | `{"exitCode":1,"outputLines":0,"canaryCreated":false,"subscription":null}` | ✓ |
| attack | config.chatbot_version carries a new line overriding the subscription | the step fails and writes no output | `{"exitCode":1,"outputLines":0,"canaryCreated":false,"subscription":null}` | ✓ |
| attack | config.chatbot_version carries a carriage return | the step fails and writes no output | `{"exitCode":1,"outputLines":0,"canaryCreated":false,"subscription":null}` | ✓ |
| attack | config.chatbot_version carries a heredoc opener | the step fails and writes no output | `{"exitCode":1,"outputLines":0,"canaryCreated":false,"subscription":null}` | ✓ |
| attack | config.domain carries a new line overriding the subscription | the step fails and writes no output | `{"exitCode":1,"outputLines":0,"canaryCreated":false,"subscription":null}` | ✓ |
| attack | config.domain carries a carriage return | the step fails and writes no output | `{"exitCode":1,"outputLines":0,"canaryCreated":false,"subscription":null}` | ✓ |
| attack | config.domain carries a heredoc opener | the step fails and writes no output | `{"exitCode":1,"outputLines":0,"canaryCreated":false,"subscription":null}` | ✓ |
| attack | Azure teardown config with a line break | fails, no output | `{"exitCode":1,"outputLines":0,"canaryCreated":false}` | ✓ |
| control | Azure teardown with a well-formed config | succeeds | `{"exitCode":0,"outputLines":8,"canaryCreated":false,"subscription":"11111111-1111-4111-8111-111111111111"}` | ✓ |
| control | AWS image replication with well-formed inputs | succeeds; images tagged into the tenant's registry | `{"exitCode":0,"outputLines":2,"canaryCreated":false,"tags":["111122223333.dkr.ecr.eu-central-1.amazonaws.com/alpha/chatbot:latest","111122223333.dkr.ecr.eu-central-1.amazonaws.com/alpha/chatbot-frontend:latest"]}` | ✓ |
| attack | chatbot_version = command substitution | no command runs; the payload is passed whole as an argument | `{"exitCode":0,"outputLines":2,"canaryCreated":false,"carriedAsArgument":true}` | ✓ |
| attack | chatbot_version = backticks | no command runs; the payload is passed whole as an argument | `{"exitCode":0,"outputLines":2,"canaryCreated":false,"carriedAsArgument":true}` | ✓ |
| attack | chatbot_version = breaking out of double quotes | no command runs; the payload is passed whole as an argument | `{"exitCode":0,"outputLines":2,"canaryCreated":false,"carriedAsArgument":true}` | ✓ |
| attack | chatbot_version = breaking out of single quotes | no command runs; the payload is passed whole as an argument | `{"exitCode":0,"outputLines":2,"canaryCreated":false,"carriedAsArgument":true}` | ✓ |
| attack | chatbot_version = a command list | no command runs; the payload is passed whole as an argument | `{"exitCode":0,"outputLines":2,"canaryCreated":false,"carriedAsArgument":true}` | ✓ |
| attack | chatbot_version = a pipe | no command runs; the payload is passed whole as an argument | `{"exitCode":0,"outputLines":2,"canaryCreated":false,"carriedAsArgument":true}` | ✓ |
| attack | chatbot_version = IFS word splitting | no command runs; the payload is passed whole as an argument | `{"exitCode":0,"outputLines":2,"canaryCreated":false,"carriedAsArgument":true}` | ✓ |
| attack | tenant_slug = command substitution | no command runs; the payload is passed whole as an argument | `{"exitCode":0,"outputLines":2,"canaryCreated":false,"carriedAsArgument":true}` | ✓ |
| attack | tenant_slug = backticks | no command runs; the payload is passed whole as an argument | `{"exitCode":0,"outputLines":2,"canaryCreated":false,"carriedAsArgument":true}` | ✓ |
| attack | tenant_slug = breaking out of double quotes | no command runs; the payload is passed whole as an argument | `{"exitCode":0,"outputLines":2,"canaryCreated":false,"carriedAsArgument":true}` | ✓ |
| attack | tenant_slug = breaking out of single quotes | no command runs; the payload is passed whole as an argument | `{"exitCode":0,"outputLines":2,"canaryCreated":false,"carriedAsArgument":true}` | ✓ |
| attack | tenant_slug = a command list | no command runs; the payload is passed whole as an argument | `{"exitCode":0,"outputLines":2,"canaryCreated":false,"carriedAsArgument":true}` | ✓ |
| attack | tenant_slug = a pipe | no command runs; the payload is passed whole as an argument | `{"exitCode":0,"outputLines":2,"canaryCreated":false,"carriedAsArgument":true}` | ✓ |
| attack | tenant_slug = IFS word splitting | no command runs; the payload is passed whole as an argument | `{"exitCode":0,"outputLines":2,"canaryCreated":false,"carriedAsArgument":true}` | ✓ |
| attack | your_ecr_image = command substitution | no command runs; the payload is passed whole as an argument | `{"exitCode":0,"outputLines":2,"canaryCreated":false,"carriedAsArgument":true}` | ✓ |
| attack | your_ecr_image = backticks | no command runs; the payload is passed whole as an argument | `{"exitCode":0,"outputLines":2,"canaryCreated":false,"carriedAsArgument":true}` | ✓ |
| attack | your_ecr_image = breaking out of double quotes | no command runs; the payload is passed whole as an argument | `{"exitCode":0,"outputLines":2,"canaryCreated":false,"carriedAsArgument":true}` | ✓ |
| attack | your_ecr_image = breaking out of single quotes | no command runs; the payload is passed whole as an argument | `{"exitCode":0,"outputLines":2,"canaryCreated":false,"carriedAsArgument":true}` | ✓ |
| attack | your_ecr_image = a command list | no command runs; the payload is passed whole as an argument | `{"exitCode":0,"outputLines":2,"canaryCreated":false,"carriedAsArgument":true}` | ✓ |
| attack | your_ecr_image = a pipe | no command runs; the payload is passed whole as an argument | `{"exitCode":0,"outputLines":2,"canaryCreated":false,"carriedAsArgument":true}` | ✓ |
| attack | your_ecr_image = IFS word splitting | no command runs; the payload is passed whole as an argument | `{"exitCode":0,"outputLines":2,"canaryCreated":false,"carriedAsArgument":true}` | ✓ |
| attack | aws_region = command substitution | no command runs; the payload is passed whole as an argument | `{"exitCode":0,"outputLines":2,"canaryCreated":false,"carriedAsArgument":true}` | ✓ |
| attack | aws_region = backticks | no command runs; the payload is passed whole as an argument | `{"exitCode":0,"outputLines":2,"canaryCreated":false,"carriedAsArgument":true}` | ✓ |
| attack | aws_region = breaking out of double quotes | no command runs; the payload is passed whole as an argument | `{"exitCode":0,"outputLines":2,"canaryCreated":false,"carriedAsArgument":true}` | ✓ |
| attack | aws_region = breaking out of single quotes | no command runs; the payload is passed whole as an argument | `{"exitCode":0,"outputLines":2,"canaryCreated":false,"carriedAsArgument":true}` | ✓ |
| attack | aws_region = a command list | no command runs; the payload is passed whole as an argument | `{"exitCode":0,"outputLines":2,"canaryCreated":false,"carriedAsArgument":true}` | ✓ |
| attack | aws_region = a pipe | no command runs; the payload is passed whole as an argument | `{"exitCode":0,"outputLines":2,"canaryCreated":false,"carriedAsArgument":true}` | ✓ |
| attack | aws_region = IFS word splitting | no command runs; the payload is passed whole as an argument | `{"exitCode":0,"outputLines":2,"canaryCreated":false,"carriedAsArgument":true}` | ✓ |
| attack | chatbot_version of 30,001 characters | no command runs; the value arrives intact | `{"exitCode":0,"outputLines":2,"canaryCreated":false,"intact":true}` | ✓ |
| attack | deploy-tenant.yml: tenant_slug with a line break | the guard fails the run | `{"exitCode":1}` | ✓ |
| control | deploy-tenant.yml: clean inputs | the guard passes | `{"exitCode":0}` | ✓ |
| attack | destroy-tenant.yml: tenant_slug with a line break | the guard fails the run | `{"exitCode":1}` | ✓ |
| control | destroy-tenant.yml: clean inputs | the guard passes | `{"exitCode":0}` | ✓ |
| attack | deploy-tenant-azure.yml: tenant_slug with a line break | the guard fails the run | `{"exitCode":1}` | ✓ |
| control | deploy-tenant-azure.yml: clean inputs | the guard passes | `{"exitCode":0}` | ✓ |
| attack | destroy-tenant-azure.yml: tenant_slug with a line break | the guard fails the run | `{"exitCode":1}` | ✓ |
| control | destroy-tenant-azure.yml: clean inputs | the guard passes | `{"exitCode":0}` | ✓ |
| attack | deploy-tenant.yml: an input reaches $GITHUB_OUTPUT before the guard | the guard comes first | `{"guardAt":1,"firstWriterAt":7,"writers":["Replicate images to client ECR","Read customer Pinecone key"]}` | ✓ |
| attack | destroy-tenant.yml: an input reaches $GITHUB_OUTPUT before the guard | the guard comes first | `{"guardAt":1,"firstWriterAt":6,"writers":["Read customer Pinecone key"]}` | ✓ |
| attack | deploy-tenant-azure.yml: an input reaches $GITHUB_OUTPUT before the guard | the guard comes first | `{"guardAt":1,"firstWriterAt":3,"writers":["Parse tenant config","Compute resource names"]}` | ✓ |
| attack | destroy-tenant-azure.yml: an input reaches $GITHUB_OUTPUT before the guard | the guard comes first | `{"guardAt":1,"firstWriterAt":3,"writers":["Parse tenant config"]}` | ✓ |
| attack | An input expanded into a script's source | none, across every step of every workflow | `{"stepsScanned":59,"pasted":[]}` | ✓ |
