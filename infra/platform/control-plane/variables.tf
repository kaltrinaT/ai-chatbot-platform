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
