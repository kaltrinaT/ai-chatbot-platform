variable "aws_region" {
  description = "Region the template bucket lives in. Any region works; the URL is what matters."
  type        = string
  default     = "eu-central-1"
}

variable "bucket_name" {
  description = <<-EOT
    Globally unique S3 bucket name for the public bootstrap templates, e.g.
    ai-chatbot-platform-bootstrap. It appears in every customer's Quick Create
    and Deploy to Azure link, so pick a name that plainly belongs to the
    platform — a customer is being asked to trust what it serves.
  EOT
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$", var.bucket_name))
    error_message = "Must be a valid S3 bucket name: 3-63 characters, lowercase letters, digits, hyphens and dots."
  }
}
