# ──────────────────────────────────────────────────────────────────────
# Public hosting for the two customer bootstrap templates.
#
# Applied by the platform operator, in the platform's own AWS account,
# whenever infra/bootstrap/** changes:
#
#   terraform init
#   terraform apply -var 'bucket_name=<globally-unique-name>'
#
# Then set the `template_base_url` output as PLATFORM_BOOTSTRAP_TEMPLATE_BASE_URL
# in the platform application's environment.
#
# Why these objects are public. Neither cloud can fetch a template from a
# private location: CloudFormation reads the S3 object server-side with no
# credential of the customer's, and the Azure portal fetches its template from
# the customer's own browser. A private repository is unreachable to both, and
# so is a control plane running on localhost.
#
# Public means readable, and only these two objects are. They contain no
# customer data and no platform secret: every tenant-specific value — the
# tenant ID, the slug, the repository, the platform's account ID — arrives as a
# template parameter in the link the wizard builds. What is published here is
# the *shape* of the identity a customer creates, which is the thing the
# customer is being asked to review anyway, and which SECURITY.md documents in
# full.
#
# State stays local, like the other platform roots: applied rarely, and it
# holds object metadata rather than anything sensitive. *.tfstate is
# gitignored.
# ──────────────────────────────────────────────────────────────────────

terraform {
  required_version = ">= 1.6"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.60"
    }
  }
}

provider "aws" {
  region = var.aws_region
}

locals {
  templates = {
    "aws/tenant-bootstrap.yaml" = {
      source       = "${path.module}/../../bootstrap/aws/tenant-bootstrap.yaml"
      content_type = "text/yaml"
    }
    "azure/tenant-bootstrap.json" = {
      source       = "${path.module}/../../bootstrap/azure/tenant-bootstrap.json"
      content_type = "application/json"
    }
  }
}

resource "aws_s3_bucket" "templates" {
  bucket = var.bucket_name
}

# Versioning is what makes a bad publish recoverable. A customer halfway
# through onboarding is fetching these objects, so a broken template is a
# broken onboarding for everyone until it is replaced.
resource "aws_s3_bucket_versioning" "templates" {
  bucket = aws_s3_bucket.templates.id

  versioning_configuration {
    status = "Enabled"
  }
}

# The default block would override the bucket policy below and make the
# objects unreadable. ACLs stay blocked: the policy is the only thing granting
# access, so there is exactly one place to read to know who can see what.
resource "aws_s3_bucket_public_access_block" "templates" {
  bucket = aws_s3_bucket.templates.id

  block_public_acls       = true
  ignore_public_acls      = true
  block_public_policy     = false
  restrict_public_buckets = false
}

data "aws_iam_policy_document" "public_read" {
  statement {
    sid    = "PublicReadTemplates"
    effect = "Allow"

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    # Read only, and only the objects. No ListBucket: the bucket's contents
    # are not browsable, so this grants what the two links need and nothing
    # that would let the bucket be enumerated.
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.templates.arn}/*"]
  }
}

resource "aws_s3_bucket_policy" "templates" {
  bucket = aws_s3_bucket.templates.id
  policy = data.aws_iam_policy_document.public_read.json

  # Without this the policy can be rejected as a public policy before the
  # block above has been relaxed.
  depends_on = [aws_s3_bucket_public_access_block.templates]
}

# The Azure portal fetches the template with JavaScript running on
# portal.azure.com, so the response needs to permit that origin. CloudFormation
# fetches server-side and needs none of this.
resource "aws_s3_bucket_cors_configuration" "templates" {
  bucket = aws_s3_bucket.templates.id

  cors_rule {
    allowed_methods = ["GET", "HEAD"]
    allowed_origins = ["https://portal.azure.com"]
    allowed_headers = ["*"]
    max_age_seconds = 3600
  }
}

resource "aws_s3_object" "template" {
  for_each = local.templates

  bucket       = aws_s3_bucket.templates.id
  key          = each.key
  source       = each.value.source
  content_type = each.value.content_type

  # Republishes the object whenever the file changes. Without it Terraform
  # compares only the arguments above, which never change, and an edited
  # template would sit in the repository while customers kept fetching the
  # old one.
  etag = filemd5(each.value.source)

  # Short enough that a corrected template reaches customers in minutes, long
  # enough that the console's own repeated fetches are not re-downloads.
  cache_control = "public, max-age=300"
}
