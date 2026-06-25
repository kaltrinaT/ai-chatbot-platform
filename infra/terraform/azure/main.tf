provider "azurerm" {
  features {}
  subscription_id               = var.azure_subscription_id
  tenant_id                     = var.azure_tenant_id
  client_id                     = var.azure_client_id
  client_secret                 = var.azure_client_secret
  resource_provider_registrations = "none"
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
  name         = "pinecone-api-key"
  value        = var.pinecone_api_key
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

  secret {
    name  = "pinecone-api-key"
    value = var.pinecone_api_key
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
        name        = "PINECONE_API_KEY"
        secret_name = "pinecone-api-key"
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
        name  = "PINECONE_INDEX"
        value = "chatbot-${var.tenant_slug}"
      }
    }
  }

  ingress {
    external_enabled = true
    target_port      = var.container_port

    traffic_weight {
      percentage      = 100
      latest_revision = true
    }
  }
}
