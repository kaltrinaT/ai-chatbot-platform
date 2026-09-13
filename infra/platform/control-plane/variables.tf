variable "aws_region" {
  description = "Region for the provider's API calls. IAM is global, so any region the account can use works."
  type        = string
  default     = "us-east-1"
}

variable "role_name" {
  description = "Name of the IAM role the platform application assumes."
  type        = string
  default     = "platform-control-plane"
}

variable "operator_principal_arns" {
  description = "IAM principals allowed to assume the role from a sign-in session: the operator's IAM user for `aws login`, or an IAM Identity Center permission set's role."
  type        = list(string)

  # Named principals only. An account root here would hand the role to any
  # principal in the account that holds a broad sts:AssumeRole grant.
  validation {
    condition = (
      length(var.operator_principal_arns) > 0
      && alltrue([for arn in var.operator_principal_arns : can(regex("^arn:aws:iam::[0-9]{12}:(user|role)/[A-Za-z0-9+=,.@_/-]+$", arn))])
    )
    error_message = "operator_principal_arns must be a non-empty list of IAM user or role ARNs. Wildcards and account roots are not allowed."
  }
}

variable "vercel_team_slug" {
  description = "Vercel team (or personal account) slug hosting the control plane. Empty disables host federation, leaving only the operator sign-in path."
  type        = string
  default     = ""
}

variable "vercel_project_name" {
  description = "Vercel project name of the control plane. Empty disables host federation."
  type        = string
  default     = ""
}

variable "vercel_environment" {
  description = "Which Vercel environment may assume the role."
  type        = string
  default     = "production"

  # Preview deployments exist for every branch, so trusting that environment
  # would give any pushed branch a role that reaches customer accounts.
  validation {
    condition     = contains(["production", "preview", "development"], var.vercel_environment)
    error_message = "vercel_environment must be production, preview or development, and production is the only sensible choice for a role that can reach customer accounts."
  }
}

variable "vercel_oidc_issuer" {
  description = "Override for the OIDC issuer URL. Empty derives https://oidc.vercel.com/<team>, which is Vercel's default."
  type        = string
  default     = ""
}

variable "vercel_oidc_audience" {
  description = "Override for the token audience. Empty derives https://vercel.com/<team>, which is Vercel's default."
  type        = string
  default     = ""
}

variable "create_vercel_oidc_provider" {
  description = "Create the IAM OIDC provider for the Vercel issuer. Set false if the account already registers it; AWS allows only one provider per issuer URL."
  type        = bool
  default     = true
}
