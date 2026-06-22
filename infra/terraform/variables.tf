variable "tenant_slug" {
  description = "Lowercase-dash tenant identifier; used in every resource name."
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$", var.tenant_slug))
    error_message = "tenant_slug must be 3–32 characters, lowercase alphanumeric and hyphens only, and must not start or end with a hyphen."
  }
}

variable "aws_region" {
  description = "Region all resources are created in."
  type        = string

  validation {
    condition     = can(regex("^[a-z]{2}-[a-z]+-[0-9]$", var.aws_region))
    error_message = "aws_region must be a valid AWS region name (e.g. us-east-1, eu-west-2)."
  }
}

variable "image_uri" {
  description = "Full ECR image URI INCLUDING tag (the client-account ECR URI after the workflow pushes it)."
  type        = string

  validation {
    condition     = can(regex("^[0-9]{12}\\.dkr\\.ecr\\.[a-z]{2}-[a-z]+-[0-9]\\.amazonaws\\.com/.+:.+$", var.image_uri))
    error_message = "image_uri must be a full ECR URI with a tag, e.g. 123456789012.dkr.ecr.us-east-1.amazonaws.com/repo/name:tag."
  }
}

variable "s3_docs_prefix" {
  description = "Optional prefix inside s3_docs_bucket. Empty string disables the prefix scope."
  type        = string
  default     = ""

  validation {
    condition     = !can(regex("^/", var.s3_docs_prefix))
    error_message = "s3_docs_prefix must not start with a leading slash."
  }
}

variable "llm_provider" {
  description = "openai | anthropic | openrouter — the chatbot reads this to pick its API client."
  type        = string

  validation {
    condition     = contains(["openai", "anthropic", "openrouter"], var.llm_provider)
    error_message = "llm_provider must be \"openai\", \"anthropic\", or \"openrouter\"."
  }
}

variable "llm_model" {
  description = "Model name passed to the chatbot. Empty string uses the container default per provider."
  type        = string
  default     = ""
}

variable "pinecone_api_key" {
  description = "Pinecone API key — Terraform writes it to Secrets Manager in the customer account."
  type        = string
  sensitive   = true
}

variable "llm_secret_arn" {
  description = "ARN of the Secrets Manager secret holding the LLM API key. Pre-created by the platform during onboarding."
  type        = string

  validation {
    condition     = can(regex("^arn:aws:secretsmanager:[a-z]{2}-[a-z]+-[0-9]:[0-9]{12}:secret:.+$", var.llm_secret_arn))
    error_message = "llm_secret_arn must be a valid Secrets Manager ARN, e.g. arn:aws:secretsmanager:us-east-1:123456789012:secret:my-secret-abc123."
  }
}

variable "domain" {
  description = "Optional custom hostname. Empty string = HTTP only via ALB DNS."
  type        = string
  default     = ""

  validation {
    condition     = var.domain == "" || can(regex("^([a-zA-Z0-9-]+\\.)+[a-zA-Z]{2,}$", var.domain))
    error_message = "domain must be empty or a valid fully-qualified hostname (e.g. chat.example.com). Do not include http:// or a trailing slash."
  }
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

variable "task_cpu" {
  type    = number
  default = 1024

  validation {
    condition     = contains([256, 512, 1024, 2048, 4096], var.task_cpu)
    error_message = "task_cpu must be a Fargate-valid CPU value: 256, 512, 1024, 2048, or 4096."
  }
}

variable "task_memory" {
  type    = number
  default = 2048

  validation {
    condition     = var.task_memory >= 512 && var.task_memory <= 30720 && var.task_memory % 512 == 0
    error_message = "task_memory must be between 512 and 30720 MB and a multiple of 512."
  }
}
