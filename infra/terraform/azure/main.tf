provider "azurerm" {
  features {}
  subscription_id            = var.azure_subscription_id
  tenant_id                  = var.azure_tenant_id
  client_id                  = var.azure_client_id
  client_secret              = var.azure_client_secret
  skip_provider_registration = true
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

resource "azurerm_resource_group" "this" {
  name     = local.name
  location = var.azure_region
  tags     = local.common_tags
}

# ──────────────────────────────────────────────────────────────────────
# Container Registry (ACR)
# ──────────────────────────────────────────────────────────────────────

resource "azurerm_container_registry" "this" {
  name                = local.acr_name
  resource_group_name = azurerm_resource_group.this.name
  location            = azurerm_resource_group.this.location
  sku                 = "Basic"
  admin_enabled       = true
  tags                = local.common_tags
}

# ──────────────────────────────────────────────────────────────────────
# Key Vault — stores LLM API key; Container App reads it at runtime
# ──────────────────────────────────────────────────────────────────────

resource "azurerm_key_vault" "this" {
  name                = local.kv_name
  location            = azurerm_resource_group.this.location
  resource_group_name = azurerm_resource_group.this.name
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

resource "azurerm_key_vault_secret" "storage_key" {
  name         = "storage-key"
  value        = azurerm_storage_account.docs.primary_access_key
  key_vault_id = azurerm_key_vault.this.id
}

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
  resource_group_name = azurerm_resource_group.this.name
  location            = azurerm_resource_group.this.location

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
  resource_group_name      = azurerm_resource_group.this.name
  location                 = azurerm_resource_group.this.location
  account_tier             = "Standard"
  account_replication_type = "LRS"
  tags                     = local.common_tags
}

resource "azurerm_storage_container" "docs" {
  name                  = "documents"
  storage_account_name  = azurerm_storage_account.docs.name
  container_access_type = "private"
}

# ──────────────────────────────────────────────────────────────────────
# Log Analytics + Container Apps environment
# ──────────────────────────────────────────────────────────────────────

resource "azurerm_log_analytics_workspace" "this" {
  name                = "${local.name}-logs"
  location            = azurerm_resource_group.this.location
  resource_group_name = azurerm_resource_group.this.name
  sku                 = "PerGB2018"
  retention_in_days   = 30
  tags                = local.common_tags
}

resource "azurerm_container_app_environment" "this" {
  name                       = "${local.name}-env"
  location                   = azurerm_resource_group.this.location
  resource_group_name        = azurerm_resource_group.this.name
  log_analytics_workspace_id = azurerm_log_analytics_workspace.this.id
  tags                       = local.common_tags
}

# ──────────────────────────────────────────────────────────────────────
# Container App
# ──────────────────────────────────────────────────────────────────────

resource "azurerm_container_app" "this" {
  name                         = local.name
  container_app_environment_id = azurerm_container_app_environment.this.id
  resource_group_name          = azurerm_resource_group.this.name
  revision_mode                = "Single"
  tags                         = local.common_tags

  registry {
    server               = azurerm_container_registry.this.login_server
    username             = azurerm_container_registry.this.admin_username
    password_secret_name = "acr-password"
  }

  secret {
    name  = "acr-password"
    value = azurerm_container_registry.this.admin_password
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

  secret {
    name  = "storage-key"
    value = azurerm_storage_account.docs.primary_access_key
  }

  template {
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
      env {
        name        = "AZURE_STORAGE_KEY"
        secret_name = "storage-key"
      }
      env {
        name  = "VECTOR_STORE"
        value = var.vector_store
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
