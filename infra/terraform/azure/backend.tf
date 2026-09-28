terraform {
  # 1.7 for the `removed` block in main.tf. The workflows pin 1.15.3.
  required_version = ">= 1.7"
  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 3.110"
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
