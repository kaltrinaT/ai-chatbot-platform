variable "tenant_slug" {
  description = "Lowercase-dash tenant identifier; used in every resource name."
  type        = string

  # 21, not 32: the frontend's target group is named "chatbot-<slug>-ui" and
  # AWS rejects any target group name over 32 characters — mid-apply, after
  # the VPC and load balancer already exist.
  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9-]{1,19}[a-z0-9]$", var.tenant_slug))
    error_message = "tenant_slug must be 3–21 characters, lowercase alphanumeric and hyphens only, and must not start or end with a hyphen."
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
  description = "Full ECR image URI INCLUDING tag for the backend (the client-account ECR URI after the workflow pushes it)."
  type        = string

  validation {
    condition     = can(regex("^[0-9]{12}\\.dkr\\.ecr\\.[a-z]{2}-[a-z]+-[0-9]\\.amazonaws\\.com/.+:.+$", var.image_uri))
    error_message = "image_uri must be a full ECR URI with a tag, e.g. 123456789012.dkr.ecr.us-east-1.amazonaws.com/repo/name:tag."
  }
}

variable "frontend_image_uri" {
  description = "Full ECR image URI INCLUDING tag for the chat UI (client-account ECR URI after the workflow pushes it)."
  type        = string

  validation {
    condition     = can(regex("^[0-9]{12}\\.dkr\\.ecr\\.[a-z]{2}-[a-z]+-[0-9]\\.amazonaws\\.com/.+:.+$", var.frontend_image_uri))
    error_message = "frontend_image_uri must be a full ECR URI with a tag."
  }
}

variable "frontend_port" {
  description = "Port the frontend (nginx) container listens on."
  type        = number
  default     = 80
}

variable "frontend_cpu" {
  type    = number
  default = 256
}

variable "frontend_memory" {
  type    = number
  default = 512
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

# Cosine-similarity floor a retrieved chunk must clear to reach the prompt.
# Too high and the chatbot answers every question with "I don't have enough
# information", because the gate empties the match list before the LLM is
# called — which is exactly what the container's old hard-coded 0.5 did to
# every real document. Left unset here, the container's own default applies;
# this exists so a tenant can be retuned without rebuilding the image.
variable "retrieval_min_score" {
  description = "Minimum cosine similarity for a retrieved chunk to be used as context. Empty string uses the container default."
  type        = string
  default     = ""

  validation {
    condition = var.retrieval_min_score == "" || (
      can(tonumber(var.retrieval_min_score)) &&
      tonumber(var.retrieval_min_score) >= 0 &&
      tonumber(var.retrieval_min_score) <= 1
    )
    error_message = "retrieval_min_score must be empty or a number between 0 and 1."
  }
}


variable "vector_store" {
  description = "Where embeddings live: \"pinecone\" (customer's own Pinecone project) or \"pgvector\" (RDS PostgreSQL inside this VPC)."
  type        = string
  default     = "pinecone"

  validation {
    condition     = contains(["pinecone", "pgvector"], var.vector_store)
    error_message = "vector_store must be either \"pinecone\" or \"pgvector\"."
  }
}

variable "pinecone_api_key" {
  description = "The CUSTOMER's Pinecone API key, read from their Secrets Manager by the workflow. Only used to provision the index; empty when vector_store is pgvector."
  type        = string
  sensitive   = true
  default     = ""
}

variable "pinecone_secret_arn" {
  description = "ARN of the customer-account secret holding their Pinecone API key, written by the platform during onboarding. Empty when vector_store is pgvector."
  type        = string
  default     = ""
}

variable "pinecone_environment" {
  description = "Pinecone serverless region for the tenant's index (e.g. us-east-1)."
  type        = string
  default     = "us-east-1"
}

variable "vector_db_instance_class" {
  description = "RDS instance class for the pgvector store."
  type        = string
  default     = "db.t4g.micro"
}

variable "vector_db_storage_gb" {
  description = "Allocated storage (GB) for the pgvector store."
  type        = number
  default     = 32
}

variable "llm_secret_arn" {
  description = "ARN of the Secrets Manager secret holding the LLM API key. Pre-created by the platform during onboarding."
  type        = string

  validation {
    condition     = can(regex("^arn:aws:secretsmanager:[a-z]{2}-[a-z]+-[0-9]:[0-9]{12}:secret:.+$", var.llm_secret_arn))
    error_message = "llm_secret_arn must be a valid Secrets Manager ARN, e.g. arn:aws:secretsmanager:us-east-1:123456789012:secret:my-secret-abc123."
  }
}

variable "docs_signer_secret_arn" {
  description = "ARN of the Secrets Manager secret holding the docs-signer Lambda's shared auth secret. Written once by the platform during onboarding, like llm_secret_arn — Terraform only ever references the ARN, never the value."
  type        = string
  default     = ""

  # Empty is permitted only so teardown can never be blocked by a missing
  # field. A deploy always carries a real ARN: triggerDeployment refuses to
  # dispatch a tenant without one (see src/lib/deploy.ts), so the empty case
  # never reaches an apply.
  validation {
    condition     = var.docs_signer_secret_arn == "" || can(regex("^arn:aws:secretsmanager:[a-z]{2}-[a-z]+-[0-9]:[0-9]{12}:secret:.+$", var.docs_signer_secret_arn))
    error_message = "docs_signer_secret_arn must be empty or a valid Secrets Manager ARN."
  }
}

variable "platform_origin" {
  description = "Origin (scheme+host) of the platform's own web UI. Used for S3 CORS on the docs bucket so the browser can upload directly to S3."
  type        = string
}

# Mirrors extra_cors_origin in infra/terraform/azure/variables.tf — the two
# clouds should agree on which origins may upload, and only Azure had this.
variable "extra_cors_origin" {
  description = "Additional origin allowed to upload to the docs bucket, alongside platform_origin. Intended for a developer machine (e.g. http://localhost:3000) while testing; empty for normal tenant deploys."
  type        = string
  default     = ""

  validation {
    condition     = var.extra_cors_origin == "" || can(regex("^https?://", var.extra_cors_origin))
    error_message = "extra_cors_origin must be empty or a scheme-qualified origin, e.g. http://localhost:3000."
  }
}

variable "max_docs_upload_mb" {
  description = "Maximum single-document upload size in MB, enforced by the docs-signer Lambda's S3 presigned-POST policy."
  type        = number
  default     = 25
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

variable "enable_cdn" {
  description = <<-EOT
    Front the load balancer with a CloudFront distribution so tenants that have
    no certificate of their own still get HTTPS, on CloudFront's own
    *.cloudfront.net hostname and its own certificate.

    Ignored when acm_certificate_arn is set, since the load balancer already
    terminates TLS in that case and CloudFront would only add a hop. Turn this
    off only to accept a plaintext-only deployment deliberately.
  EOT
  type        = bool
  default     = true
}

variable "acm_certificate_arn" {
  description = <<-EOT
    ARN of an ACM certificate, in this same region, covering var.domain. When
    set, the ALB gains an HTTPS listener on 443 and port 80 becomes a 301
    redirect to it; when empty the ALB serves plain HTTP and nothing is
    encrypted in transit.

    The customer creates and validates this certificate themselves. ACM can
    only issue for a domain whose DNS the requester controls, which rules out
    the ALB's own *.elb.amazonaws.com hostname, so certificate and custom
    domain always arrive together.
  EOT
  type        = string
  default     = ""

  validation {
    condition     = var.acm_certificate_arn == "" || can(regex("^arn:aws:acm:[a-z0-9-]+:[0-9]{12}:certificate/.+$", var.acm_certificate_arn))
    error_message = "acm_certificate_arn must be empty or a valid ACM certificate ARN (arn:aws:acm:REGION:ACCOUNT:certificate/ID)."
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
