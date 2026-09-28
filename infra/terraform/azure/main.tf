# No client secret. The provider authenticates as the customer's identity by
# exchanging the workflow's GitHub OIDC token, which it requests itself through
# ACTIONS_ID_TOKEN_REQUEST_URL/TOKEN whenever it needs a fresh one, so a long
# apply never outlives its credential. The customer's federated credential
# decides which runs may do this (see src/lib/azureFederation.ts).
#
# use_cli = false keeps authentication explicit: without it, a missing OIDC
# token would fall back silently to whatever `az` session the runner holds,
# and a run could succeed on a credential this configuration never names.
#
# storage_use_azuread = true because the docs storage account refuses Shared
# Key authorization (see azurerm_storage_account.docs), and azurerm otherwise
# manages containers with the account key. It does not give the deploy
# identity access to documents: with Entra ID, container-level operations
# (create, read properties, delete) are authorized by the control-plane
# actions its Contributor role already holds, while reading or listing blob
# content needs data actions it deliberately does not have.
provider "azurerm" {
  features {}
  subscription_id            = var.azure_subscription_id
  tenant_id                  = var.azure_tenant_id
  client_id                  = var.azure_client_id
  use_oidc                   = true
  use_cli                    = false
  skip_provider_registration = true
  storage_use_azuread        = true
}

provider "pinecone" {
  api_key = var.pinecone_api_key
}

data "azurerm_client_config" "current" {}

locals {
  name         = "chatbot-${var.tenant_slug}"
  acr_name     = substr(replace("chatbot${var.tenant_slug}", "-", ""), 0, 50)
  kv_name      = "cb-${var.tenant_slug}-kv"
  storage_name = substr(replace("chatbot${var.tenant_slug}", "-", ""), 0, 24)

  common_tags = {
    Project = "ai-chatbot-platform"
    Tenant  = var.tenant_slug
  }

  llm_base_url = {
    openai     = "https://api.openai.com/v1"
    anthropic  = "https://api.anthropic.com/v1"
    openrouter = "https://openrouter.ai/api/v1"
  }[var.llm_provider]

  llm_default_model = {
    openai     = "gpt-4o-mini"
    anthropic  = "claude-3-5-haiku-20241022"
    openrouter = "meta-llama/llama-3.3-70b-instruct:free"
  }[var.llm_provider]

  llm_model = var.llm_model != "" ? var.llm_model : local.llm_default_model

  use_pinecone = var.vector_store == "pinecone"
  use_pgvector = var.vector_store == "pgvector"

  pg_name = substr("${local.name}-pg", 0, 63)
}

# ──────────────────────────────────────────────────────────────────────
# Resource group
# ──────────────────────────────────────────────────────────────────────

# Read, not created. The customer's bootstrap deployment creates this group
# and then scopes the deployment identity's permissions to it — see
# infra/bootstrap/azure/tenant-bootstrap.json. Creating it here instead would
# force the identity to hold subscription-wide Contributor, since a group has
# to exist before anything can be confined to it.
#
# The consequence for teardown is deliberate: `terraform destroy` empties this
# group but leaves the group and the identity standing, so a redeploy needs no
# second bootstrap. Deleting the group — which also deletes the identity and
# its federated credential — is the customer's revocation handle, and it is
# theirs to pull rather than the platform's.
#
# A deploy that runs before the bootstrap fails here, naming the missing
# group, which is a far clearer failure than the permission error it would
# otherwise hit somewhere in the middle of the apply.
data "azurerm_resource_group" "this" {
  name = local.name
}

# Tenants deployed before the bootstrap existed had Terraform create this
# group, so their state still holds it as a managed resource. Without this
# block, reading it instead would plan to destroy it — and with it the
# identity and state account the bootstrap has since put inside it. This drops
# it from state and leaves it standing. For any other tenant it does nothing.
removed {
  from = azurerm_resource_group.this

  lifecycle {
    destroy = false
  }
}

# ──────────────────────────────────────────────────────────────────────
# Container Registry (ACR)
# ──────────────────────────────────────────────────────────────────────

resource "azurerm_container_registry" "this" {
  name                = local.acr_name
  resource_group_name = data.azurerm_resource_group.this.name
  location            = data.azurerm_resource_group.this.location
  sku                 = "Basic"
  tags                = local.common_tags

  # No admin user. It is one shared username and password with push and pull
  # over the whole registry, and it used to be handed to the Container App as
  # a secret. Pulls now go through the chatbot's user-assigned identity holding
  # AcrPull (below). Pushes go through `az acr login`, which uses the deploying
  # service principal's Entra token and never needed the admin user.
  admin_enabled = false
}

# ──────────────────────────────────────────────────────────────────────
# Chatbot runtime identity
#
# User-assigned rather than system-assigned, because of an ordering problem a
# system-assigned identity cannot solve: it does not exist until the Container
# App does, and the Container App cannot create its first revision until it can
# pull its image. The pull permission could never be in place in time.
#
# Created in the bootstrap apply, alongside the registry and before any image
# is pushed, so its AcrPull grant has time to propagate before the full apply
# creates the app (see deploy-tenant-azure.yml).
#
# Deliberately separate from the docs-signer's identity. This one pulls images
# and reads documents; the signer's writes and deletes documents and nothing
# else. Neither holds the other's permissions.
# ──────────────────────────────────────────────────────────────────────

resource "azurerm_user_assigned_identity" "chatbot" {
  name                = "${local.name}-chatbot-id"
  resource_group_name = data.azurerm_resource_group.this.name
  location            = data.azurerm_resource_group.this.location
  tags                = local.common_tags
}

resource "azurerm_role_assignment" "chatbot_acr_pull" {
  scope                = azurerm_container_registry.this.id
  role_definition_name = "AcrPull"
  principal_id         = azurerm_user_assigned_identity.chatbot.principal_id
  # A freshly created identity may not have replicated through Entra ID yet,
  # and the assignment API rejects principals it cannot look up. Skipping that
  # lookup is the documented remedy for exactly this case.
  skip_service_principal_aad_check = true
}

# ──────────────────────────────────────────────────────────────────────
# Key Vault — stores LLM API key; Container App reads it at runtime
# ──────────────────────────────────────────────────────────────────────

// Only the deploying identity gets data-plane access, and it is declared
// inline. Nothing else may add an azurerm_key_vault_access_policy resource to
// this vault: azurerm reconciles the whole policy list from this block on
// every apply, so a separately-managed grant gets silently deleted (which is
// exactly what happened to the docs-signer Function, leaving it unable to
// resolve a Key Vault reference and rejecting every request). The Function
// therefore receives its secret as a direct app setting instead of a
// reference — see azurerm_linux_function_app.docs_signer.
resource "azurerm_key_vault" "this" {
  name                = local.kv_name
  location            = data.azurerm_resource_group.this.location
  resource_group_name = data.azurerm_resource_group.this.name
  tenant_id           = var.azure_tenant_id
  sku_name            = "standard"
  tags                = local.common_tags

  access_policy {
    tenant_id = var.azure_tenant_id
    object_id = data.azurerm_client_config.current.object_id

    secret_permissions = ["Get", "Set", "Delete", "List", "Purge"]
  }
}

resource "azurerm_key_vault_secret" "llm_api_key" {
  name         = "llm-api-key"
  value        = var.llm_api_key
  key_vault_id = azurerm_key_vault.this.id
}

resource "azurerm_key_vault_secret" "pinecone_api_key" {
  count = local.use_pinecone ? 1 : 0

  name         = "pinecone-api-key"
  value        = var.pinecone_api_key
  key_vault_id = azurerm_key_vault.this.id
}

# The storage account key is deliberately not stored anywhere. Nothing in
# this deployment uses it: the chatbot reads blobs through its managed
# identity and the docs-signer writes through its own. Keeping a copy in the
# vault would reintroduce, at rest, exactly the credential the identities
# exist to avoid.

# ──────────────────────────────────────────────────────────────────────
# Vector store — exactly one of the two blocks below is created, chosen by
# var.vector_store.
#
#   "pinecone" — a dedicated index in the CUSTOMER's own Pinecone project.
#                Cheaper and nothing to operate, but embeddings leave the
#                customer's subscription.
#   "pgvector" — Azure Database for PostgreSQL Flexible Server with the
#                pgvector extension. Embeddings never leave the customer's
#                subscription, at the cost of a managed database.
# ──────────────────────────────────────────────────────────────────────

resource "pinecone_index" "this" {
  count = local.use_pinecone ? 1 : 0

  name      = local.name
  dimension = 384 # must match the all-MiniLM-L6-v2 embedding output
  metric    = "cosine"

  # Pinecone serverless is hosted on AWS/GCP/Azure independently of where the
  # tenant's own infrastructure runs; the customer's project decides billing.
  spec = {
    serverless = {
      cloud  = "aws"
      region = var.pinecone_environment
    }
  }

  # Offboarding a tenant is `terraform destroy`; the index must go with it.
  deletion_protection = "disabled"
}

resource "random_password" "vectors" {
  count = local.use_pgvector ? 1 : 0

  length = 32
  # The value is embedded in a connection URL, so avoid characters that would
  # need percent-encoding.
  special = false
}

resource "azurerm_postgresql_flexible_server" "vectors" {
  count = local.use_pgvector ? 1 : 0

  name                = local.pg_name
  resource_group_name = data.azurerm_resource_group.this.name
  location            = data.azurerm_resource_group.this.location

  version                = "16"
  sku_name               = var.vector_db_sku
  storage_mb             = var.vector_db_storage_mb
  administrator_login    = "chatbot"
  administrator_password = random_password.vectors[0].result

  backup_retention_days        = 7
  geo_redundant_backup_enabled = false
  zone                         = "1"

  # Container Apps without VNet integration egress from rotating Azure IPs, so
  # the server keeps public networking and is fenced by the firewall rule
  # below rather than by private endpoints. See SECURITY.md.
  public_network_access_enabled = true

  tags = local.common_tags
}

# pgvector must be allow-listed at the server level before the backend can run
# CREATE EXTENSION vector.
resource "azurerm_postgresql_flexible_server_configuration" "vectors_extensions" {
  count = local.use_pgvector ? 1 : 0

  name      = "azure.extensions"
  server_id = azurerm_postgresql_flexible_server.vectors[0].id
  value     = "VECTOR"
}

resource "azurerm_postgresql_flexible_server_database" "vectors" {
  count = local.use_pgvector ? 1 : 0

  name      = "vectors"
  server_id = azurerm_postgresql_flexible_server.vectors[0].id
  charset   = "UTF8"
  collation = "en_US.utf8"
}

# 0.0.0.0 is the special "allow other Azure services" rule — it does NOT open
# the server to the public internet.
resource "azurerm_postgresql_flexible_server_firewall_rule" "azure_services" {
  count = local.use_pgvector ? 1 : 0

  name             = "allow-azure-services"
  server_id        = azurerm_postgresql_flexible_server.vectors[0].id
  start_ip_address = "0.0.0.0"
  end_ip_address   = "0.0.0.0"
}

resource "azurerm_key_vault_secret" "vector_db_url" {
  count = local.use_pgvector ? 1 : 0

  name = "vector-db-url"
  value = format(
    "postgresql://%s:%s@%s/%s?sslmode=require",
    azurerm_postgresql_flexible_server.vectors[0].administrator_login,
    random_password.vectors[0].result,
    azurerm_postgresql_flexible_server.vectors[0].fqdn,
    azurerm_postgresql_flexible_server_database.vectors[0].name,
  )
  key_vault_id = azurerm_key_vault.this.id
}

# ──────────────────────────────────────────────────────────────────────
# Storage Account — documents bucket created by the platform
# ──────────────────────────────────────────────────────────────────────

resource "azurerm_storage_account" "docs" {
  name                     = local.storage_name
  resource_group_name      = data.azurerm_resource_group.this.name
  location                 = data.azurerm_resource_group.this.location
  account_tier             = "Standard"
  account_replication_type = "LRS"
  tags                     = local.common_tags

  min_tls_version = "TLS1_2"

  # No Shared Key authorization. The account key reads, writes and lists
  # every document, and Terraform records it in state whether or not anything
  # uses it — and state sits outside the customer's account. Nothing needs it:
  # the chatbot reads through its managed identity, the docs-signer signs
  # user-delegation SAS tokens with its own, and Terraform manages the
  # container through Entra ID (storage_use_azuread on the provider). With
  # this off, the key in state cannot authorize anything; turning it back on
  # takes control-plane rights on this account, which state alone does not
  # give. SECURITY.md, Known Limitation #9.
  shared_access_key_enabled = false

  # The container below is private, but this defaults to true, which leaves
  # anyone with control-plane rights able to flip a container to public. There
  # is no case in this deployment where a tenant's documents should be
  # anonymously readable.
  allow_nested_items_to_be_public = false

  # The browser PUTs document bytes directly to Blob Storage using a SAS
  # minted by the docs-signer Function below — a cross-origin request from
  # the platform's own origin, so it needs CORS. Mirrors
  # aws_s3_bucket_cors_configuration.docs in infra/terraform/main.tf (Azure
  # nests CORS inside the storage account resource rather than as a
  # separate one).
  blob_properties {
    # The Azure half of the same durability problem as S3 versioning: the
    # docs-signer can delete, the chatbot's index never purges the vectors of
    # a deleted document, so a mistaken delete otherwise leaves embeddings
    # answering for a document nobody can recover.
    delete_retention_policy {
      days = 30
    }

    cors_rule {
      # compact() drops extra_cors_origin when it's empty, so a tenant
      # deploy allows exactly the platform's own origin unless one is
      # explicitly configured.
      allowed_origins    = compact([var.platform_origin, var.extra_cors_origin])
      allowed_methods    = ["PUT"]
      allowed_headers    = ["*"]
      exposed_headers    = ["*"]
      max_age_in_seconds = 3000
    }
  }
}

resource "azurerm_storage_container" "docs" {
  name                  = "documents"
  storage_account_name  = azurerm_storage_account.docs.name
  container_access_type = "private"
}

# ──────────────────────────────────────────────────────────────────────
# Docs-signer Function — the ONLY component with write/delete access to the
# docs container besides the tenant themselves. Its managed identity holds
# a custom role limited to generateUserDelegationKey + blobs/write +
# blobs/delete (never read, never list) so that even full possession of its
# credentials cannot read a document's content. The platform reaches it over
# plain authenticated HTTPS (shared-secret header, no Azure AD token) — the
# platform itself never holds an Azure credential capable of touching this
# storage account. Mirrors the docs-signer Lambda in infra/terraform/main.tf.
#
# The secret below is written to the vault as a durable record, but the
# Function does NOT read it from there: it arrives as an app setting (see
# azurerm_linux_function_app.docs_signer), so the Function's identity holds
# no Key Vault access at all. That matters because this vault uses the
# access-policy authorization model, which is vault-scoped rather than
# per-secret — unlike AWS IAM, which scopes secretsmanager:GetSecretValue to
# a single ARN. Granting this identity a read here would therefore have
# exposed every other secret in the vault, so it is deliberately not granted.
# The only access policy on this vault belongs to the deploying service
# principal. See DOCUMENT-MANAGEMENT.md.
# ──────────────────────────────────────────────────────────────────────

resource "azurerm_key_vault_secret" "docs_signer" {
  name         = "docs-signer-secret"
  value        = var.docs_signer_secret
  key_vault_id = azurerm_key_vault.this.id
}

# Azure Functions requires its own storage account for internal bookkeeping
# (triggers, logs). Kept separate from azurerm_storage_account.docs so the
# docs-signer identity's storage role never needs to touch anything beyond
# the tenant's actual documents container. Truncated to 22 chars (not 24,
# like local.storage_name) so the "fn" suffix always survives truncation
# and this account's name can never collide with the docs account's.
resource "azurerm_storage_account" "function_runtime" {
  name                     = "${substr(replace("chatbot${var.tenant_slug}", "-", ""), 0, 22)}fn"
  resource_group_name      = data.azurerm_resource_group.this.name
  location                 = data.azurerm_resource_group.this.location
  account_tier             = "Standard"
  account_replication_type = "LRS"
  tags                     = local.common_tags

  # Unlike the docs account, this one keeps Shared Key on, deliberately: on a
  # Linux Consumption plan the Functions host reaches its storage, and zip
  # deployment stages the code package here, through the account key. The
  # key therefore also sits in state, and whoever holds it could replace the
  # staged package. It holds no documents. Removing it needs the Flex
  # Consumption plan, which supports identity-based host storage —
  # SECURITY.md, Known Limitation #9.
  shared_access_key_enabled = true
}

resource "azurerm_service_plan" "docs_signer" {
  name                = "${local.name}-docs-signer-plan"
  resource_group_name = data.azurerm_resource_group.this.name
  location            = data.azurerm_resource_group.this.location
  os_type             = "Linux"
  sku_name            = "Y1" # Consumption — pay-per-execution, matches the Lambda's pricing model
  tags                = local.common_tags
}

resource "azurerm_linux_function_app" "docs_signer" {
  name                       = "${local.name}-docs-signer"
  resource_group_name        = data.azurerm_resource_group.this.name
  location                   = data.azurerm_resource_group.this.location
  service_plan_id            = azurerm_service_plan.docs_signer.id
  storage_account_name       = azurerm_storage_account.function_runtime.name
  storage_account_access_key = azurerm_storage_account.function_runtime.primary_access_key
  https_only                 = true
  tags                       = local.common_tags

  # No username/password publishing. Every Function App carries publishing
  # credentials that can deploy code — code that would run as this app's
  # identity, with its write and delete rights on the documents — and
  # Terraform records them in state as site_credential. The deploy workflow
  # never uses them: Azure/functions-action deploys with the run's federated
  # identity. With both of these off, the recorded credentials authorize
  # nothing. SECURITY.md, Known Limitation #9.
  ftp_publish_basic_authentication_enabled       = false
  webdeploy_publish_basic_authentication_enabled = false

  identity {
    type = "SystemAssigned"
  }

  site_config {
    application_stack {
      node_version = "20"
    }
  }

  app_settings = {
    FUNCTIONS_WORKER_RUNTIME = "node"
    DOCS_STORAGE_ACCOUNT     = azurerm_storage_account.docs.name
    DOCS_CONTAINER           = azurerm_storage_container.docs.name
    DOCS_PREFIX              = var.docs_prefix
    MAX_UPLOAD_BYTES         = tostring(var.max_docs_upload_mb * 1024 * 1024)
    # Passed directly rather than as a "@Microsoft.KeyVault(SecretUri=...)"
    # reference. A reference would need this Function's identity to hold a
    # Key Vault access policy, and azurerm rebuilds the vault's policy list
    # from the inline block on every apply — deleting that grant and leaving
    # the Function with an empty secret that rejects every request. The value
    # is still written to Key Vault (azurerm_key_vault_secret.docs_signer) so
    # the customer can see and rotate it; this is only how it reaches the
    # Function's environment.
    DOCS_SIGNER_SECRET = var.docs_signer_secret
  }
}

# Grants ONLY what the Function needs on the docs storage account: mint a
# user-delegation key (to sign SAS tokens), write blobs, and delete them.
# Never read, never list — the same shape as the Lambda's
# s3:PutObject/s3:DeleteObject-only IAM policy.
#
# blobs/write is required even though the Function never uploads anything
# itself: a user-delegation SAS is capped by the RBAC permissions of the
# identity that signed it, so without write here the browser's PUT fails with
# AuthorizationPermissionMismatch. Same principle as the Lambda needing
# s3:PutObject to issue a presigned POST it never uses itself.
resource "azurerm_role_definition" "docs_signer" {
  name        = "${local.name}-docs-signer"
  scope       = azurerm_storage_account.docs.id
  description = "Presign uploads (via user-delegation key) and delete blobs in this tenant's docs container. No read, no list."

  permissions {
    # Minting the delegation key is a control-plane action; operating on blob
    # contents is a data-plane one. Azure rejects the role definition outright
    # if a data action is listed under `actions`.
    actions = [
      "Microsoft.Storage/storageAccounts/blobServices/generateUserDelegationKey/action",
    ]
    data_actions = [
      "Microsoft.Storage/storageAccounts/blobServices/containers/blobs/write",
      "Microsoft.Storage/storageAccounts/blobServices/containers/blobs/delete",
    ]
  }

  assignable_scopes = [azurerm_storage_account.docs.id]
}

resource "azurerm_role_assignment" "docs_signer_storage" {
  scope              = azurerm_storage_account.docs.id
  role_definition_id = azurerm_role_definition.docs_signer.role_definition_resource_id
  principal_id       = azurerm_linux_function_app.docs_signer.identity[0].principal_id
}

# The chatbot's own role: the exact mirror image of the signer's. The signer
# may write and delete but never read; the chatbot may read but never write.
# Neither can do the other's job, and neither can reach anything in this
# storage account beyond the documents themselves.
#
# Narrower than the built-in Storage Blob Data Reader, which also carries
# generateUserDelegationKey — the ability to mint SAS tokens. Only the signer
# needs that, so only the signer has it.
resource "azurerm_role_definition" "chatbot_docs_reader" {
  name        = "${local.name}-chatbot-docs-reader"
  scope       = azurerm_storage_account.docs.id
  description = "Read and list documents in this tenant's docs container. No write, no delete, no SAS minting."

  permissions {
    # Listing is a container operation, reading a blob is a data operation.
    # Azure rejects the definition outright if these are not filed under the
    # right heading, the same constraint the signer's role runs into.
    actions = [
      "Microsoft.Storage/storageAccounts/blobServices/containers/read",
    ]
    data_actions = [
      "Microsoft.Storage/storageAccounts/blobServices/containers/blobs/read",
    ]
  }

  assignable_scopes = [azurerm_storage_account.docs.id]
}

resource "azurerm_role_assignment" "chatbot_docs_reader" {
  scope              = azurerm_storage_account.docs.id
  role_definition_id = azurerm_role_definition.chatbot_docs_reader.role_definition_resource_id
  principal_id       = azurerm_user_assigned_identity.chatbot.principal_id
  # Not in the bootstrap apply, unlike AcrPull: its scope, the docs storage
  # account, does not exist yet at that point. It does not need to be early
  # either, because documents are read at reindex time, long after the app
  # has started.
  skip_service_principal_aad_check = true
}

# The Function deliberately has NO Key Vault access: it receives its auth
# secret as an app setting, so its identity is scoped to the storage account
# alone (see azurerm_role_definition.docs_signer above). This also removes
# the vault-wide "Get" it used to hold — access policies can't be scoped to a
# single secret, so that grant had exposed every other secret in the vault.

# ──────────────────────────────────────────────────────────────────────
# Log Analytics + Container Apps environment
# ──────────────────────────────────────────────────────────────────────

resource "azurerm_log_analytics_workspace" "this" {
  name                = "${local.name}-logs"
  location            = data.azurerm_resource_group.this.location
  resource_group_name = data.azurerm_resource_group.this.name
  sku                 = "PerGB2018"
  retention_in_days   = 30
  tags                = local.common_tags
}

resource "azurerm_container_app_environment" "this" {
  name                       = "${local.name}-env"
  location                   = data.azurerm_resource_group.this.location
  resource_group_name        = data.azurerm_resource_group.this.name
  log_analytics_workspace_id = azurerm_log_analytics_workspace.this.id
  tags                       = local.common_tags
}

# ──────────────────────────────────────────────────────────────────────
# Container App
# ──────────────────────────────────────────────────────────────────────

resource "azurerm_container_app" "this" {
  name                         = local.name
  container_app_environment_id = azurerm_container_app_environment.this.id
  resource_group_name          = data.azurerm_resource_group.this.name
  revision_mode                = "Single"
  tags                         = local.common_tags

  # The chatbot pulls its image and reads documents as its own identity. It
  # used to be handed two shared secrets instead: the registry's admin
  # password, and the storage account's primary access key — read, write,
  # delete and list over the entire account, strictly more authority than the
  # AWS task has ever had for the same job. See azurerm_user_assigned_identity
  # .chatbot for why this identity is user-assigned.
  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.chatbot.id]
  }

  registry {
    server   = azurerm_container_registry.this.login_server
    identity = azurerm_user_assigned_identity.chatbot.id
  }

  secret {
    name  = "llm-api-key"
    value = var.llm_api_key
  }

  dynamic "secret" {
    for_each = local.use_pinecone ? [1] : []
    content {
      name  = "pinecone-api-key"
      value = var.pinecone_api_key
    }
  }

  dynamic "secret" {
    for_each = local.use_pgvector ? [1] : []
    content {
      name  = "vector-db-url"
      value = azurerm_key_vault_secret.vector_db_url[0].value
    }
  }


  template {
    # Tenant images are pushed to a mutable tag (chatbot_version, usually
    # "latest"), so image_uri is byte-identical across deploys and Terraform
    # would plan no change — leaving the app serving the digest it first
    # pulled, however many times the image is rebuilt. Varying the revision
    # suffix per deploy forces a new revision, which re-pulls the tag.
    revision_suffix = var.revision_suffix != "" ? var.revision_suffix : null

    min_replicas = 1
    max_replicas = 3

    container {
      name   = "chatbot"
      image  = var.image_uri
      cpu    = 0.5
      memory = "1Gi"

      env {
        name  = "PORT"
        value = tostring(var.container_port)
      }
      env {
        name  = "TENANT_ID"
        value = var.tenant_slug
      }
      env {
        name  = "LLM_PROVIDER"
        value = var.llm_provider
      }
      env {
        name        = "LLM_API_KEY"
        secret_name = "llm-api-key"
      }
      env {
        name        = "OPENAI_API_KEY"
        secret_name = "llm-api-key"
      }
      env {
        name        = "ANTHROPIC_API_KEY"
        secret_name = "llm-api-key"
      }
      env {
        name  = "AZURE_STORAGE_ACCOUNT"
        value = local.storage_name
      }
      env {
        name  = "AZURE_STORAGE_CONTAINER"
        value = azurerm_storage_container.docs.name
      }
      # No AZURE_STORAGE_KEY, and the backend has no code path that would use
      # one: it always authenticates with DefaultAzureCredential, as the
      # managed identity declared above (see _load_from_azure in the backend).
      #
      # AZURE_CLIENT_ID is what makes that work with a USER-assigned identity.
      # The app has no system-assigned identity for the managed identity
      # endpoint to default to, so DefaultAzureCredential reads this variable
      # to choose one. Without it every blob read fails to authenticate even
      # though the role assignment is correct.
      env {
        name  = "AZURE_CLIENT_ID"
        value = azurerm_user_assigned_identity.chatbot.client_id
      }
      env {
        name  = "VECTOR_STORE"
        value = var.vector_store
      }

      dynamic "env" {
        for_each = var.retrieval_min_score != "" ? [1] : []
        content {
          name  = "RETRIEVAL_MIN_SCORE"
          value = var.retrieval_min_score
        }
      }

      dynamic "env" {
        for_each = local.use_pinecone ? [1] : []
        content {
          name        = "PINECONE_API_KEY"
          secret_name = "pinecone-api-key"
        }
      }
      dynamic "env" {
        for_each = local.use_pinecone ? [1] : []
        content {
          name  = "PINECONE_INDEX"
          value = pinecone_index.this[0].name
        }
      }
      dynamic "env" {
        for_each = local.use_pinecone ? [1] : []
        content {
          name  = "PINECONE_ENVIRONMENT"
          value = var.pinecone_environment
        }
      }

      dynamic "env" {
        for_each = local.use_pgvector ? [1] : []
        content {
          name        = "DATABASE_URL"
          secret_name = "vector-db-url"
        }
      }
      dynamic "env" {
        for_each = local.use_pgvector ? [1] : []
        content {
          name        = "PGVECTOR_URL"
          secret_name = "vector-db-url"
        }
      }
      dynamic "env" {
        for_each = local.use_pgvector ? [1] : []
        content {
          name  = "PGVECTOR_TABLE"
          value = "embeddings"
        }
      }
      dynamic "env" {
        for_each = local.use_pgvector ? [1] : []
        content {
          name  = "PGVECTOR_DIMENSION"
          value = "384"
        }
      }

      env {
        name  = "OPENAI_BASE_URL"
        value = local.llm_base_url
      }
      env {
        name  = "OPENAI_API_BASE"
        value = local.llm_base_url
      }
      env {
        name  = "LLM_MODEL"
        value = local.llm_model
      }

      # Probes are deliberately forgiving here, because this container has a
      # failure mode nginx does not: the embedding model is loaded lazily on
      # the FIRST /ask or /index call, not at startup (see CHATBOT-LOGIC.md).
      # While that load runs, the process can stop answering /api/health even
      # though nothing is wrong. A probe tuned for a normal web service would
      # read that as a hang and restart the container mid-download, forever.
      #
      # So: the startup probe covers boot, readiness takes a stuck replica out
      # of rotation after a minute, and liveness only restarts after five
      # straight minutes of silence — long enough to sit through a cold model
      # load, short enough to recover a genuinely wedged process. Path matches
      # what the AWS backend target group already checks against this image.
      # failure_count_threshold caps at 10 on every probe, so the boot budget
      # is bought with the interval instead: 15s x 10 = 150s.
      startup_probe {
        transport               = "HTTP"
        port                    = var.container_port
        path                    = "/api/health"
        interval_seconds        = 15
        timeout                 = 5
        failure_count_threshold = 10
      }

      readiness_probe {
        transport               = "HTTP"
        port                    = var.container_port
        path                    = "/api/health"
        interval_seconds        = 10
        timeout                 = 5
        failure_count_threshold = 6
        success_count_threshold = 1
      }

      liveness_probe {
        transport               = "HTTP"
        port                    = var.container_port
        path                    = "/api/health"
        initial_delay           = 15
        interval_seconds        = 30
        timeout                 = 5
        failure_count_threshold = 10
      }
    }

    # ── Frontend: chat UI + nginx ──
    # Container Apps has no path-based ingress routing, so the frontend's
    # nginx proxies /api to the backend over localhost (same app, shared
    # network namespace) while serving the SPA for everything else.
    container {
      name   = "frontend"
      image  = var.frontend_image_uri
      cpu    = 0.25
      memory = "0.5Gi"

      env {
        name  = "BACKEND_PORT"
        value = tostring(var.container_port)
      }

      # nginx serving static files answers immediately or not at all, so these
      # can be tighter than the backend's below. Probing "/" matches what the
      # AWS frontend target group already health-checks (aws_lb_target_group
      # .frontend), against the same image.
      startup_probe {
        transport               = "HTTP"
        port                    = var.frontend_port
        path                    = "/"
        interval_seconds        = 5
        timeout                 = 3
        failure_count_threshold = 10
      }

      readiness_probe {
        transport               = "HTTP"
        port                    = var.frontend_port
        path                    = "/"
        interval_seconds        = 10
        timeout                 = 3
        failure_count_threshold = 3
        success_count_threshold = 1
      }

      liveness_probe {
        transport               = "HTTP"
        port                    = var.frontend_port
        path                    = "/"
        initial_delay           = 10
        interval_seconds        = 30
        timeout                 = 3
        failure_count_threshold = 3
      }
    }
  }

  # Public ingress targets the frontend; it proxies /api to the backend.
  ingress {
    external_enabled = true
    target_port      = var.frontend_port

    traffic_weight {
      percentage      = 100
      latest_revision = true
    }
  }
}
