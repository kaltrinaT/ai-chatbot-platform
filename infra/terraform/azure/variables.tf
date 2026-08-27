variable "tenant_slug" {
  description = "Lowercase-dash tenant identifier. Max 18 chars for Azure (Key Vault name limit)."
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9-]{1,16}[a-z0-9]$", var.tenant_slug))
    error_message = "tenant_slug must be 3–18 characters for Azure deployments (Key Vault name constraint), lowercase alphanumeric and hyphens, no leading/trailing hyphen."
  }
}

variable "azure_subscription_id" {
  description = "Customer Azure subscription ID."
  type        = string

  validation {
    condition     = can(regex("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", var.azure_subscription_id))
    error_message = "azure_subscription_id must be a valid UUID (xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx)."
  }
}

variable "azure_tenant_id" {
  description = "Customer Azure Active Directory tenant ID."
  type        = string

  validation {
    condition     = can(regex("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", var.azure_tenant_id))
    error_message = "azure_tenant_id must be a valid UUID."
  }
}

variable "azure_client_id" {
  description = "Service principal application/client ID with Contributor access on the subscription."
  type        = string

  validation {
    condition     = can(regex("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", var.azure_client_id))
    error_message = "azure_client_id must be a valid UUID."
  }
}

variable "azure_client_secret" {
  description = "Service principal client secret."
  type        = string
  sensitive   = true
}

variable "azure_region" {
  description = "Azure region for all resources (e.g. eastus, westeurope)."
  type        = string
  default     = "eastus"
}

variable "image_uri" {
  description = "Full ACR image URI including tag for the backend, pushed by the workflow."
  type        = string
}

variable "frontend_image_uri" {
  description = "Full ACR image URI including tag for the chat UI, pushed by the workflow."
  type        = string
}

variable "frontend_port" {
  description = "Port the frontend (nginx) container listens on; the Container App ingress targets this."
  type        = number
  default     = 80
}

variable "llm_provider" {
  description = "openai | anthropic | openrouter"
  type        = string

  validation {
    condition     = contains(["openai", "anthropic", "openrouter"], var.llm_provider)
    error_message = "llm_provider must be \"openai\", \"anthropic\", or \"openrouter\"."
  }
}

variable "llm_model" {
  description = "Model name passed to the chatbot. Empty string uses the default model for the provider."
  type        = string
  default     = ""
}

variable "llm_api_key" {
  description = "LLM API key retrieved from Key Vault by the workflow."
  type        = string
  sensitive   = true
}

variable "vector_store" {
  description = "Where embeddings live: \"pinecone\" (customer's own Pinecone project) or \"pgvector\" (Azure Database for PostgreSQL in this resource group)."
  type        = string
  default     = "pinecone"

  validation {
    condition     = contains(["pinecone", "pgvector"], var.vector_store)
    error_message = "vector_store must be either \"pinecone\" or \"pgvector\"."
  }
}

variable "pinecone_api_key" {
  description = "The CUSTOMER's Pinecone API key — stored in Key Vault by Terraform during deploy. Empty when vector_store is pgvector."
  type        = string
  sensitive   = true
  default     = ""
}

variable "vector_db_sku" {
  description = "SKU for the pgvector Flexible Server."
  type        = string
  default     = "B_Standard_B1ms"
}

variable "vector_db_storage_mb" {
  description = "Storage (MB) for the pgvector Flexible Server."
  type        = number
  default     = 32768
}

variable "domain" {
  description = "Optional custom hostname. Empty string = use Container Apps FQDN."
  type        = string
  default     = ""

  validation {
    condition     = var.domain == "" || can(regex("^([a-zA-Z0-9-]+\\.)+[a-zA-Z]{2,}$", var.domain))
    error_message = "domain must be empty or a valid hostname (e.g. chat.example.com)."
  }
}

variable "pinecone_environment" {
  description = "Pinecone serverless region — must match the region of the index (e.g. us-east-1)."
  type        = string
  default     = "us-east-1"
}

variable "container_port" {
  description = "Port the chatbot container listens on."
  type        = number
  default     = 8000

  validation {
    condition     = var.container_port >= 1 && var.container_port <= 65535
    error_message = "container_port must be between 1 and 65535."
  }
}
