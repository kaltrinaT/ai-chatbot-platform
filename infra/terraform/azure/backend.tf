terraform {
  # 1.11 for write-only arguments (azapi's sensitive_body in main.tf); the
  # `removed` block there needs 1.7. The workflows pin 1.15.3.
  required_version = ">= 1.11"
  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 3.110"
    }
    # For the Container Apps environment alone: azurerm cannot set its
    # environment mode (see azapi_resource.container_app_environment).
    azapi = {
      source  = "Azure/azapi"
      version = "~> 2.0"
    }
    pinecone = {
      source  = "pinecone-io/pinecone"
      version = "~> 2.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }

  # State lives in the customer's own subscription, in the storage account
  # their bootstrap creates (cbtf<slug>, container tfstate), reached through
  # Entra ID with the run's GitHub OIDC token and locked with a blob lease.
  # Every value is passed by .github/scripts/terraform-init-azure.sh, which
  # also moves the state of a tenant deployed before that account existed
  # out of the platform's S3 bucket.
  backend "azurerm" {}
}
