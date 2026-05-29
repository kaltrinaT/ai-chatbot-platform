variable "tenant_slug" {
  description = "Lowercase-dash tenant identifier; used in every resource name."
  type        = string
}

variable "aws_region" {
  description = "Region all resources are created in."
  type        = string
}

variable "image_uri" {
  description = "Full ECR image URI INCLUDING tag (the client-account ECR URI after the workflow pushes it)."
  type        = string
}

variable "s3_docs_bucket" {
  description = "Bucket the chatbot task reads documents from."
  type        = string
}

variable "s3_docs_prefix" {
  description = "Optional prefix inside s3_docs_bucket. Empty string disables the prefix scope."
  type        = string
  default     = ""
}

variable "llm_provider" {
  description = "openai | anthropic — the chatbot reads this to pick its API client."
  type        = string
}

variable "llm_secret_arn" {
  description = "ARN of the Secrets Manager secret holding the LLM API key. Pre-created by the platform during onboarding."
  type        = string
}

variable "domain" {
  description = "Optional custom hostname. Empty string = HTTP only via ALB DNS."
  type        = string
  default     = ""
}

variable "container_port" {
  description = "Port the chatbot container listens on."
  type        = number
  default     = 8080
}

variable "task_cpu" {
  type    = number
  default = 256
}

variable "task_memory" {
  type    = number
  default = 512
}
