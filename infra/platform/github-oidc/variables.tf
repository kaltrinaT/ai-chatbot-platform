variable "aws_region" {
  description = "Region for the provider's API calls. IAM is global, so any region the account can use works."
  type        = string
  default     = "us-east-1"
}

variable "github_owner" {
  description = "GitHub user or organisation owning the repository the deploy workflows run in. Must match CHATBOT_REPO_OWNER."
  type        = string
  default     = "kaltrinaT"
}

variable "github_repo" {
  description = "Repository the deploy workflows run in. Must match CHATBOT_REPO_NAME."
  type        = string
  default     = "ai-chatbot-platform"
}

variable "role_name" {
  description = "Name of the IAM role GitHub Actions assumes."
  type        = string
  default     = "platform-github-deploy"
}

variable "create_oidc_provider" {
  description = "Create GitHub's OIDC identity provider. Set false if the account already registers token.actions.githubusercontent.com; AWS allows only one provider per issuer."
  type        = bool
  default     = true
}

variable "golden_image_repository_arns" {
  description = "ARNs of the platform ECR repositories holding the golden backend and frontend images behind PLATFORM_CHATBOT_IMAGE_URI and PLATFORM_FRONTEND_IMAGE_URI."
  type        = list(string)

  validation {
    condition = (
      length(var.golden_image_repository_arns) > 0
      && alltrue([for arn in var.golden_image_repository_arns : can(regex("^arn:aws:ecr:[a-z0-9-]+:[0-9]{12}:repository/.+$", arn))])
    )
    error_message = "golden_image_repository_arns must be a non-empty list of ECR repository ARNs."
  }
}
