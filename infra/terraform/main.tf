terraform {
  # 1.11: the S3 backend's native lock file (use_lockfile) is stable from here,
  # and the deploy and destroy workflows configure it (backend.tf).
  required_version = ">= 1.11"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.60"
    }
    pinecone = {
      source  = "pinecone-io/pinecone"
      version = "~> 2.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.4"
    }
  }
}

provider "aws" {
  region = var.aws_region
}

provider "pinecone" {
  api_key = var.pinecone_api_key
}

data "aws_caller_identity" "current" {}
data "aws_availability_zones" "available" { state = "available" }

locals {
  name = "chatbot-${var.tenant_slug}"

  common_tags = {
    Project = "ai-chatbot-platform"
    Tenant  = var.tenant_slug
  }

  llm_base_url = {
    openai     = "https://api.openai.com/v1"
    anthropic  = "https://api.anthropic.com/v1"
    openrouter = "https://openrouter.ai/api/v1"
  }[var.llm_provider]

  llm_default_model = {
    openai     = "gpt-4o-mini"
    anthropic  = "claude-3-5-haiku-20241022"
    openrouter = "meta-llama/llama-3.3-70b-instruct:free"
  }[var.llm_provider]

  llm_model = var.llm_model != "" ? var.llm_model : local.llm_default_model

  use_pinecone = var.vector_store == "pinecone"
  use_pgvector = var.vector_store == "pgvector"

  # TLS is available only when the customer supplies a certificate, because
  # ACM cannot issue one for the ALB's own *.elb.amazonaws.com name — that
  # zone isn't theirs to validate. A certificate therefore implies a custom
  # domain, and the customer creates and validates it themselves in the same
  # visit to their DNS provider where they point the hostname at the ALB.
  enable_https = var.acm_certificate_arn != ""

  # The fallback for everyone else. A certificate needs a domain, and most
  # tenants bring neither, so without this they are served over plain HTTP.
  # CloudFront supplies both the hostname and the certificate, which is the
  # only way to give a tenant TLS with no action on the customer's part.
  use_cdn = var.enable_cdn && !local.enable_https
}

# ──────────────────────────────────────────────────────────────────────
# Networking — 2 public subnets, tasks get public IPs (saves NAT cost).
# Acceptable for MVP; revisit with private subnets + VPC endpoints later.
# ──────────────────────────────────────────────────────────────────────

resource "aws_vpc" "this" {
  cidr_block           = "10.20.0.0/16"
  enable_dns_hostnames = true
  enable_dns_support   = true
  tags                 = merge(local.common_tags, { Name = "${local.name}-vpc" })
}

resource "aws_internet_gateway" "this" {
  vpc_id = aws_vpc.this.id
  tags   = merge(local.common_tags, { Name = "${local.name}-igw" })
}

resource "aws_subnet" "public" {
  count                   = 2
  vpc_id                  = aws_vpc.this.id
  cidr_block              = "10.20.${count.index}.0/24"
  availability_zone       = data.aws_availability_zones.available.names[count.index]
  map_public_ip_on_launch = true
  tags                    = merge(local.common_tags, { Name = "${local.name}-public-${count.index}" })
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.this.id
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.this.id
  }
  tags = merge(local.common_tags, { Name = "${local.name}-public-rt" })
}

resource "aws_route_table_association" "public" {
  count          = 2
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

# ──────────────────────────────────────────────────────────────────────
# Security groups
# ──────────────────────────────────────────────────────────────────────

resource "aws_security_group" "alb" {
  name        = "${local.name}-alb"
  description = "ALB ingress from internet"
  vpc_id      = aws_vpc.this.id

  ingress {
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  # Only opened when there is a certificate to terminate with. Without one
  # the listener below doesn't exist, so an open 443 would accept nothing.
  dynamic "ingress" {
    for_each = local.enable_https ? [1] : []
    content {
      from_port   = 443
      to_port     = 443
      protocol    = "tcp"
      cidr_blocks = ["0.0.0.0/0"]
    }
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = local.common_tags
}

resource "aws_security_group" "task" {
  name        = "${local.name}-task"
  description = "Fargate tasks: backend + frontend ports from ALB only, all egress"
  vpc_id      = aws_vpc.this.id

  # Backend container port (ALB /api/* rule forwards here).
  ingress {
    from_port       = var.container_port
    to_port         = var.container_port
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id]
  }

  # Frontend container port (ALB default action forwards here).
  ingress {
    from_port       = var.frontend_port
    to_port         = var.frontend_port
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = local.common_tags
}

# ──────────────────────────────────────────────────────────────────────
# ALB
# ──────────────────────────────────────────────────────────────────────

resource "aws_lb" "this" {
  name               = local.name
  internal           = false
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb.id]
  subnets            = aws_subnet.public[*].id
  tags               = local.common_tags

  # POST /api/index embeds every document under the tenant's prefix in one
  # synchronous request, which routinely outlives the ALB's 60s default. The
  # platform allows that call 120s (see triggerReindex in src/lib/reindex.ts),
  # so with the default the proxy gave up first and the platform saw a 504 for
  # a reindex that was still running and would have succeeded.
  #
  # Set above the caller's own timeout so the client is what gives up, not the
  # proxy: a 504 tells you nothing about whether the work completed, whereas
  # the client timing out is at least unambiguous. The real answer is to make
  # indexing asynchronous and poll it, which belongs in the chatbot backend.
  idle_timeout = 180
}

# Backend target group — receives only /api/* via the listener rule below.
resource "aws_lb_target_group" "this" {
  name        = local.name
  port        = var.container_port
  protocol    = "HTTP"
  target_type = "ip"
  vpc_id      = aws_vpc.this.id

  health_check {
    path                = "/api/health"
    matcher             = "200-399"
    healthy_threshold   = 2
    unhealthy_threshold = 3
    interval            = 30
    timeout             = 5
  }

  tags = local.common_tags
}

# Frontend target group — serves the chat UI (everything that isn't /api/*).
resource "aws_lb_target_group" "frontend" {
  name        = "${local.name}-ui"
  port        = var.frontend_port
  protocol    = "HTTP"
  target_type = "ip"
  vpc_id      = aws_vpc.this.id

  health_check {
    path                = "/"
    matcher             = "200-399"
    healthy_threshold   = 2
    unhealthy_threshold = 3
    interval            = 30
    timeout             = 5
  }

  tags = local.common_tags
}

# Port 80. With a certificate configured this does nothing but redirect to
# 443; without one it is the only listener there is and serves traffic
# directly, in the clear. See the acm_certificate_arn variable.
resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.this.arn
  port              = 80
  protocol          = "HTTP"

  dynamic "default_action" {
    for_each = local.enable_https ? [1] : []
    content {
      type = "redirect"
      redirect {
        port        = "443"
        protocol    = "HTTPS"
        status_code = "HTTP_301"
      }
    }
  }

  dynamic "default_action" {
    for_each = local.enable_https ? [] : [1]
    content {
      type             = "forward"
      target_group_arn = aws_lb_target_group.frontend.arn
    }
  }
}

resource "aws_lb_listener" "https" {
  count = local.enable_https ? 1 : 0

  load_balancer_arn = aws_lb.this.arn
  port              = 443
  protocol          = "HTTPS"
  # TLS 1.2 floor, and 1.3 where the client supports it. Anything older is
  # not worth offering to a browser talking to a chatbot.
  ssl_policy      = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn = var.acm_certificate_arn

  # Default: serve the frontend UI.
  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.frontend.arn
  }
}

# API traffic is routed to the backend service. It hangs off whichever
# listener actually serves traffic — putting it on the HTTP listener while
# that listener is a blanket redirect would route nothing.
resource "aws_lb_listener_rule" "backend_api" {
  # one() rather than [0]: it yields null for an empty list instead of an
  # invalid-index error, so this expression stays valid however Terraform
  # chooses to evaluate the unselected branch.
  listener_arn = local.enable_https ? one(aws_lb_listener.https[*].arn) : aws_lb_listener.http.arn
  priority     = 10

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.this.arn
  }

  condition {
    path_pattern {
      values = ["/api/*"]
    }
  }
}

# ──────────────────────────────────────────────────────────────────────
# CloudFront — TLS for tenants who brought no certificate
#
# This is a viewer-facing TLS terminator, not a cache. Everything here is
# dynamic: a chat UI and a question-answering API, where a cached response
# would be a correctness bug rather than a saving. So caching is disabled
# outright and every request reaches the origin.
#
# The origin hop, CloudFront to ALB, stays HTTP. It cannot be anything else:
# the ALB has no certificate in this branch, which is the whole reason the
# distribution exists. So this encrypts the leg that crosses networks the
# customer does not control, and leaves one inside AWS that it does not.
# A tenant wanting TLS end to end supplies acm_certificate_arn instead.
# ──────────────────────────────────────────────────────────────────────

data "aws_cloudfront_cache_policy" "disabled" {
  count = local.use_cdn ? 1 : 0
  name  = "Managed-CachingDisabled"
}

# Forwards every header, cookie and query string except Host. Host has to be
# left alone so the ALB sees its own name and its listener rules still match.
data "aws_cloudfront_origin_request_policy" "all_viewer_except_host" {
  count = local.use_cdn ? 1 : 0
  name  = "Managed-AllViewerExceptHostHeader"
}

resource "aws_cloudfront_distribution" "this" {
  count = local.use_cdn ? 1 : 0

  enabled     = true
  comment     = "${local.name} — TLS front for the chatbot ALB"
  price_class = "PriceClass_100"

  # Terraform otherwise blocks until the distribution finishes propagating,
  # which is minutes of a 30-minute deploy job spent watching a progress bar.
  # Nothing downstream needs it to be live, only to exist and have a name.
  wait_for_deployment = false

  origin {
    domain_name = aws_lb.this.dns_name
    origin_id   = "alb"

    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "http-only"
      origin_ssl_protocols   = ["TLSv1.2"]
      # 60s is the ceiling CloudFront allows without a quota increase. The
      # chatbot's first request after a cold start loads an embedding model,
      # so the default 30s is not enough headroom.
      origin_read_timeout      = 60
      origin_keepalive_timeout = 60
    }
  }

  default_cache_behavior {
    target_origin_id       = "alb"
    viewer_protocol_policy = "redirect-to-https"

    # Compression is deliberately left off. It interacts with the cache
    # policy's Accept-Encoding handling, which is the one attribute here
    # nobody has been able to try against a real distribution yet, and the
    # origin can compress its own responses anyway. Turn it on once there
    # has been a successful deploy to try it against.

    # POST and friends are required: /api/ask is how the chatbot is used.
    allowed_methods = ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]
    cached_methods  = ["GET", "HEAD"]

    cache_policy_id          = data.aws_cloudfront_cache_policy.disabled[0].id
    origin_request_policy_id = data.aws_cloudfront_origin_request_policy.all_viewer_except_host[0].id
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    cloudfront_default_certificate = true
  }

  tags = local.common_tags
}

# ──────────────────────────────────────────────────────────────────────
# CloudWatch
# ──────────────────────────────────────────────────────────────────────

resource "aws_cloudwatch_log_group" "this" {
  name              = "/ecs/${local.name}"
  retention_in_days = 14
  tags              = local.common_tags
}

# ──────────────────────────────────────────────────────────────────────
# S3 — documents bucket created by the platform; client uploads docs here
# ──────────────────────────────────────────────────────────────────────

resource "aws_s3_bucket" "docs" {
  bucket = "chatbot-${var.tenant_slug}-docs"
  tags   = merge(local.common_tags, { Name = "${local.name}-docs" })

  # The platform tries to empty this bucket via the docs-signer Lambda before
  # requesting tenant destroy, but that's best-effort (e.g. tenants onboarded
  # before docs-signer existed have no way to enumerate their objects) — this
  # is the backstop so `terraform destroy` never gets blocked on a non-empty
  # bucket. Uses the same already-granted s3:* permission, no new IAM needed.
  force_destroy = true
}

# A deleted document is otherwise gone for good, and the chatbot's index only
# upserts — it never removes the vectors for a document that has disappeared.
# Without versioning the failure mode is the worst available combination: the
# source document is unrecoverable while its embeddings keep answering
# questions about it. The destroy workflow already empties this bucket
# "object versions included", so teardown still works.
resource "aws_s3_bucket_versioning" "docs" {
  bucket = aws_s3_bucket.docs.id

  versioning_configuration {
    status = "Enabled"
  }
}

# Versioning without an expiry is a slow cost leak: every re-upload of a
# document keeps the previous copy forever, on a bucket the customer pays for
# and nobody ever prunes. Thirty days matches the Azure container's soft-delete
# window, so a mistaken delete is recoverable for the same period on both
# clouds and costs the same bounded amount.
resource "aws_s3_bucket_lifecycle_configuration" "docs" {
  bucket = aws_s3_bucket.docs.id

  rule {
    id     = "expire-noncurrent-versions"
    status = "Enabled"

    filter {}

    noncurrent_version_expiration {
      noncurrent_days = 30
    }

    # An upload the browser abandons midway otherwise bills indefinitely for
    # parts no request will ever complete.
    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }

  depends_on = [aws_s3_bucket_versioning.docs]
}

resource "aws_s3_bucket_server_side_encryption_configuration" "docs" {
  bucket = aws_s3_bucket.docs.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "docs" {
  bucket                  = aws_s3_bucket.docs.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# The browser uploads document bytes directly to S3 via a presigned POST
# minted by the docs-signer Lambda below — that's a cross-origin request from
# the platform's own origin, so it needs CORS. Nothing else touches this
# bucket from a browser.
resource "aws_s3_bucket_cors_configuration" "docs" {
  bucket = aws_s3_bucket.docs.id

  cors_rule {
    allowed_methods = ["POST"]
    # compact() drops extra_cors_origin when it's empty, so a tenant deploy
    # allows exactly the platform's own origin and nothing more. Mirrors
    # azure_storage_account.docs in infra/terraform/azure/main.tf.
    allowed_origins = compact([var.platform_origin, var.extra_cors_origin])
    allowed_headers = ["*"]
    max_age_seconds = 3000
  }
}

# ──────────────────────────────────────────────────────────────────────
# Docs-signer Lambda — the ONLY component with write access to the docs
# bucket besides the tenant themselves. It holds s3:PutObject/DeleteObject
# ONLY (never GetObject, never ListBucket) so that even full possession of
# its credentials cannot read a document's content. The platform reaches it
# over plain authenticated HTTPS (shared-secret header, no AWS SigV4) — the
# platform itself never holds an AWS credential capable of touching this
# bucket. See ARCHITECTURE.md.
# ──────────────────────────────────────────────────────────────────────

data "aws_iam_policy_document" "assume_lambda" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "docs_signer" {
  name               = "${local.name}-docs-signer"
  assume_role_policy = data.aws_iam_policy_document.assume_lambda.json
  tags               = local.common_tags
}

resource "aws_iam_role_policy_attachment" "docs_signer_logs" {
  role       = aws_iam_role.docs_signer.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "docs_signer_s3" {
  name = "write-docs-bucket"
  role = aws_iam_role.docs_signer.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["s3:PutObject", "s3:DeleteObject"]
        Resource = "${aws_s3_bucket.docs.arn}/${var.s3_docs_prefix}*"
      }
    ]
  })
}

# Terraform (running under the broad deployment role) never reads this
# secret's value — only references its ARN as a string. Only the Lambda's
# own narrow role can actually read it.
resource "aws_iam_role_policy" "docs_signer_secret_read" {
  name = "read-docs-signer-secret"
  role = aws_iam_role.docs_signer.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["secretsmanager:GetSecretValue"]
        Resource = var.docs_signer_secret_arn
      }
    ]
  })
}

data "archive_file" "docs_signer" {
  type        = "zip"
  source_dir  = "${path.module}/../lambda/docs-signer"
  output_path = "${path.module}/.build/docs-signer-${var.tenant_slug}.zip"
}

resource "aws_cloudwatch_log_group" "docs_signer" {
  name              = "/aws/lambda/${local.name}-docs-signer"
  retention_in_days = 14
  tags              = local.common_tags
}

resource "aws_lambda_function" "docs_signer" {
  function_name    = "${local.name}-docs-signer"
  role             = aws_iam_role.docs_signer.arn
  handler          = "index.handler"
  runtime          = "nodejs20.x"
  timeout          = 10
  memory_size      = 128
  filename         = data.archive_file.docs_signer.output_path
  source_code_hash = data.archive_file.docs_signer.output_base64sha256

  environment {
    variables = {
      DOCS_BUCKET            = aws_s3_bucket.docs.bucket
      DOCS_PREFIX            = var.s3_docs_prefix
      DOCS_SIGNER_SECRET_ARN = var.docs_signer_secret_arn
      MAX_UPLOAD_BYTES       = tostring(var.max_docs_upload_mb * 1024 * 1024)
    }
  }

  depends_on = [aws_cloudwatch_log_group.docs_signer]

  tags = local.common_tags
}

# Public-but-secret-gated: authorization_type = NONE means no AWS SigV4 is
# required to invoke it (the platform holds no AWS credential to sign with —
# that's the point), auth is enforced inside the handler via a shared-secret
# header. Only ever called server-to-server from the platform, never from a
# browser.
resource "aws_lambda_function_url" "docs_signer" {
  function_name      = aws_lambda_function.docs_signer.function_name
  authorization_type = "NONE"
}

# Required, and easy to miss: authorization_type = "NONE" only says the URL
# does not want SigV4. It does not by itself let anyone through. Lambda still
# checks the function's resource-based policy on every Function URL request,
# and with no statement permitting the invoke it answers 403 "Forbidden. For
# troubleshooting Function URL authorization issues..." before the handler
# ever runs — so the shared-secret check inside index.mjs never gets a say.
# (The console adds this statement for you when you create a public Function
# URL by hand; Terraform does not.)
#
# principal = "*" is scoped by function_url_auth_type: it grants exactly one
# action, on this one function, through its Function URL. The secret header
# checked in the handler remains the actual authentication.
#
# NOT SUFFICIENT ON ITS OWN. Since October 2025 a Function URL also requires a
# lambda:InvokeFunction statement carrying the lambda:InvokedViaFunctionUrl
# condition; without it Lambda still answers 403. That statement cannot be
# written here: it needs aws_lambda_permission's invoked_via_function_url
# argument, added in AWS provider 6.28.0, and this module pins ~> 5.60. AWS
# rejects the only form 5.x can emit ("FunctionUrlAuthType is only supported
# for lambda:InvokeFunctionUrl action"). It is granted instead by the
# "Grant the docs-signer Function URL its invoke permission" step in
# .github/workflows/deploy-tenant.yml — fold that step back in here when the
# provider constraint is raised.
resource "aws_lambda_permission" "docs_signer_url" {
  statement_id           = "AllowDocsSignerFunctionUrlInvoke"
  action                 = "lambda:InvokeFunctionUrl"
  function_name          = aws_lambda_function.docs_signer.function_name
  principal              = "*"
  function_url_auth_type = "NONE"
}

# ──────────────────────────────────────────────────────────────────────
# Vector store — exactly one of the two blocks below is created, chosen by
# var.vector_store.
#
#   "pinecone" — a dedicated index in the CUSTOMER's own Pinecone project.
#                Cheaper and nothing to operate, but embeddings leave the
#                customer's cloud account.
#   "pgvector" — RDS PostgreSQL with the pgvector extension, inside this
#                VPC. Embeddings never leave the customer's account, at the
#                cost of a managed database.
# ──────────────────────────────────────────────────────────────────────

resource "pinecone_index" "this" {
  count = local.use_pinecone ? 1 : 0

  name      = local.name
  dimension = 384 # must match the all-MiniLM-L6-v2 embedding output
  metric    = "cosine"

  spec = {
    serverless = {
      cloud  = "aws"
      region = var.pinecone_environment
    }
  }

  # Offboarding a tenant is `terraform destroy`; the index must go with it.
  deletion_protection = "disabled"
}

# Reachable only from the ECS tasks — no public IP, no ingress from the ALB.
resource "aws_security_group" "vectors" {
  count = local.use_pgvector ? 1 : 0

  name        = "${local.name}-vectors"
  description = "Postgres vector store: ingress from the chatbot tasks only"
  vpc_id      = aws_vpc.this.id

  ingress {
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.task.id]
  }

  tags = local.common_tags
}

resource "aws_db_subnet_group" "vectors" {
  count = local.use_pgvector ? 1 : 0

  name       = "${local.name}-vectors"
  subnet_ids = aws_subnet.public[*].id
  tags       = local.common_tags
}

resource "random_password" "vectors" {
  count = local.use_pgvector ? 1 : 0

  length = 32
  # RDS rejects '/', '@', '"' and space in master passwords, and the value is
  # embedded in a connection URL, so stick to alphanumerics.
  special = false
}

resource "aws_db_instance" "vectors" {
  count = local.use_pgvector ? 1 : 0

  identifier     = "${local.name}-vectors"
  engine         = "postgres"
  engine_version = "16"
  instance_class = var.vector_db_instance_class

  allocated_storage = var.vector_db_storage_gb
  storage_type      = "gp3"
  storage_encrypted = true

  db_name  = "vectors"
  username = "chatbot"
  password = random_password.vectors[0].result

  db_subnet_group_name   = aws_db_subnet_group.vectors[0].name
  vpc_security_group_ids = [aws_security_group.vectors[0].id]
  publicly_accessible    = false

  backup_retention_period = 7
  skip_final_snapshot     = true
  apply_immediately       = true

  tags = local.common_tags
}

# The full connection URL (with password) is a secret, so it is injected via
# the execution role rather than as a plaintext env var.
resource "aws_secretsmanager_secret" "vectors" {
  count = local.use_pgvector ? 1 : 0

  name        = "${var.tenant_slug}/vector-db-url"
  description = "pgvector connection URL for tenant ${var.tenant_slug} (managed by ai-chatbot-platform)"
  tags        = local.common_tags
}

resource "aws_secretsmanager_secret_version" "vectors" {
  count = local.use_pgvector ? 1 : 0

  secret_id = aws_secretsmanager_secret.vectors[0].id
  secret_string = format(
    "postgresql://%s:%s@%s/%s?sslmode=require",
    aws_db_instance.vectors[0].username,
    random_password.vectors[0].result,
    aws_db_instance.vectors[0].endpoint,
    aws_db_instance.vectors[0].db_name,
  )
}

# ──────────────────────────────────────────────────────────────────────
# IAM
# ──────────────────────────────────────────────────────────────────────

data "aws_iam_policy_document" "assume_ecs_task" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "execution" {
  name               = "${local.name}-execution"
  assume_role_policy = data.aws_iam_policy_document.assume_ecs_task.json
  tags               = local.common_tags
}

resource "aws_iam_role_policy_attachment" "execution_managed" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role_policy" "execution_secret_read" {
  name = "read-secrets"
  role = aws_iam_role.execution.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = ["secretsmanager:GetSecretValue"]
      Resource = concat(
        [var.llm_secret_arn],
        local.use_pinecone ? [var.pinecone_secret_arn] : [],
        local.use_pgvector ? [aws_secretsmanager_secret.vectors[0].arn] : [],
      )
    }]
  })
}

resource "aws_iam_role" "task" {
  name               = "${local.name}-task"
  assume_role_policy = data.aws_iam_policy_document.assume_ecs_task.json
  tags               = local.common_tags
}

resource "aws_iam_role_policy" "task_s3_docs" {
  name = "read-docs-bucket"
  role = aws_iam_role.task.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["s3:ListBucket"]
        Resource = aws_s3_bucket.docs.arn
      },
      {
        Effect   = "Allow"
        Action   = ["s3:GetObject"]
        Resource = "${aws_s3_bucket.docs.arn}/${var.s3_docs_prefix}*"
      }
    ]
  })
}

# ──────────────────────────────────────────────────────────────────────
# ECS
# ──────────────────────────────────────────────────────────────────────

resource "aws_ecs_cluster" "this" {
  name = local.name
  tags = local.common_tags
}

resource "aws_ecs_task_definition" "this" {
  family                   = local.name
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = var.task_cpu
  memory                   = var.task_memory
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn

  container_definitions = jsonencode([{
    name      = "chatbot"
    image     = var.image_uri
    essential = true
    portMappings = [{
      containerPort = var.container_port
      protocol      = "tcp"
    }]
    environment = concat(
      [
        { name = "TENANT_ID", value = var.tenant_slug },
        { name = "S3_DOCS_BUCKET", value = aws_s3_bucket.docs.bucket },
        { name = "S3_DOCS_PREFIX", value = var.s3_docs_prefix },
        { name = "LLM_PROVIDER", value = var.llm_provider },
        { name = "AWS_REGION", value = var.aws_region },
        { name = "PORT", value = tostring(var.container_port) },
        { name = "VECTOR_STORE", value = var.vector_store },
        { name = "OPENAI_BASE_URL", value = local.llm_base_url },
        { name = "OPENAI_API_BASE", value = local.llm_base_url },
        { name = "LLM_MODEL", value = local.llm_model }
      ],
      var.retrieval_min_score != "" ? [
        { name = "RETRIEVAL_MIN_SCORE", value = var.retrieval_min_score }
      ] : [],
      local.use_pinecone ? [
        { name = "PINECONE_INDEX", value = pinecone_index.this[0].name }
      ] : [],
      local.use_pgvector ? [
        { name = "PGVECTOR_TABLE", value = "embeddings" },
        { name = "PGVECTOR_DIMENSION", value = "384" }
      ] : [],
    )
    secrets = concat(
      [
        { name = "LLM_API_KEY", valueFrom = var.llm_secret_arn },
        { name = "OPENAI_API_KEY", valueFrom = var.llm_secret_arn },
        { name = "ANTHROPIC_API_KEY", valueFrom = var.llm_secret_arn }
      ],
      local.use_pinecone ? [
        { name = "PINECONE_API_KEY", valueFrom = var.pinecone_secret_arn }
      ] : [],
      local.use_pgvector ? [
        { name = "DATABASE_URL", valueFrom = aws_secretsmanager_secret.vectors[0].arn },
        { name = "PGVECTOR_URL", valueFrom = aws_secretsmanager_secret.vectors[0].arn }
      ] : [],
    )
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.this.name
        awslogs-region        = var.aws_region
        awslogs-stream-prefix = "chatbot"
      }
    }
  }])

  tags = local.common_tags
}

resource "aws_ecs_service" "this" {
  name            = local.name
  cluster         = aws_ecs_cluster.this.id
  task_definition = aws_ecs_task_definition.this.arn
  desired_count   = 1
  launch_type     = "FARGATE"

  # Without this, "redeploy" does not redeploy. Tenant images are tagged by
  # chatbot_version, which defaults to "latest" — a mutable tag. A deploy
  # replicates the new image into the tenant's ECR under the same tag, so the
  # task definition's image string is unchanged, Terraform sees no diff, and
  # ECS keeps the existing tasks running the code they pulled when they last
  # started. Observed directly: a tenant kept serving a build from hours
  # earlier while the fixed image sat unused in its own registry.
  #
  # Forcing a new deployment on every apply is the honest behaviour for a
  # platform whose redeploy button is meant to ship new chatbot code. The
  # alternative, tagging images by digest or commit so the task definition
  # changes on its own, is better but means changing how versions are minted.
  force_new_deployment = true

  # Without these two, force_new_deployment above is a loaded gun. A broken
  # image gets rolled out, the tasks fail their health checks, ECS replaces
  # them forever, and `terraform apply` returns success the moment it has
  # registered the new task definition — so the workflow goes green and the
  # platform records a succeeded deployment for a tenant that is down.
  #
  # The circuit breaker gives ECS permission to give up and put the previous
  # task definition back; wait_for_steady_state makes Terraform stay until the
  # service actually settles, so a rollback surfaces as a failed apply and a
  # failed deployment rather than a silent one. The cost is that an apply now
  # takes as long as the service takes to become healthy.
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  wait_for_steady_state = true

  network_configuration {
    subnets          = aws_subnet.public[*].id
    security_groups  = [aws_security_group.task.id]
    assign_public_ip = true
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.this.arn
    container_name   = "chatbot"
    container_port   = var.container_port
  }

  # The secret version matters as much as the listener rule. The execution
  # role resolves the pgvector URL when a task starts, and that secret only
  # receives a value once RDS finishes creating, which took eight minutes on a
  # fresh account. The task definition references the secret's ARN, which
  # exists immediately, so without this nothing in the graph waits for the
  # value: the service launches tasks against a secret whose AWSCURRENT
  # version does not exist yet, every one fails to start, and the circuit
  # breaker fails the deployment before the value ever appears.
  depends_on = [
    aws_lb_listener_rule.backend_api,
    aws_secretsmanager_secret_version.vectors,
  ]

  tags = local.common_tags
}

# ──────────────────────────────────────────────────────────────────────
# Frontend (chat UI) — its own task definition + service, fronted by the
# same ALB. The listener default action sends all non-/api/* traffic here.
# ──────────────────────────────────────────────────────────────────────

resource "aws_ecs_task_definition" "frontend" {
  family                   = "${local.name}-frontend"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = var.frontend_cpu
  memory                   = var.frontend_memory
  execution_role_arn       = aws_iam_role.execution.arn

  container_definitions = jsonencode([{
    name      = "frontend"
    image     = var.frontend_image_uri
    essential = true
    portMappings = [{
      containerPort = var.frontend_port
      protocol      = "tcp"
    }]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.this.name
        awslogs-region        = var.aws_region
        awslogs-stream-prefix = "frontend"
      }
    }
  }])

  tags = local.common_tags
}

resource "aws_ecs_service" "frontend" {
  name            = "${local.name}-frontend"
  cluster         = aws_ecs_cluster.this.id
  task_definition = aws_ecs_task_definition.frontend.arn
  desired_count   = 1
  launch_type     = "FARGATE"

  # Same mutable-tag problem as the backend service above.
  force_new_deployment = true

  # Same reasoning as the backend service above.
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  wait_for_steady_state = true

  network_configuration {
    subnets          = aws_subnet.public[*].id
    security_groups  = [aws_security_group.task.id]
    assign_public_ip = true
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.frontend.arn
    container_name   = "frontend"
    container_port   = var.frontend_port
  }

  depends_on = [aws_lb_listener.http]

  tags = local.common_tags
}
