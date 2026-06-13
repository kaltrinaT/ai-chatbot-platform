terraform {
  required_version = ">= 1.6"
  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 3.110"
    }
  }

  backend "s3" {
    # All values injected via -backend-config flags in the workflow
    bucket  = ""
    region  = ""
    key     = ""
    encrypt = true
  }
}
