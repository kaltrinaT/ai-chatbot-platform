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
  description = "Full ACR image URI including tag pushed by the workflow."
  type        = string
}

variable "llm_provider" {
  description = "openai | anthropic | openrouter"
  type        = string

  validation {
    condition     = contains(["openai", "anthropic", "openrouter"], var.llm_provider)
    error_message = "llm_provider must be \"openai\", \"anthropic\", or \"openrouter\"."
  }
}

variable "llm_api_key" {
  description = "LLM API key retrieved from Key Vault by the workflow."
  type        = string
  sensitive   = true
}

variable "pinecone_api_key" {
  description = "Pinecone API key — stored in Key Vault by Terraform during deploy."
  type        = string
  sensitive   = true
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
