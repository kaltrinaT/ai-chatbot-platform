# ──────────────────────────────────────────────────────────────────────
# GitHub Actions -> AWS OIDC trust, in the platform's own AWS account
#
# Applied ONCE by the platform operator, with admin credentials in the platform
# account. It is not part of any tenant's Terraform. It creates the identity
# GitHub Actions uses to act as the platform, replacing the static
# AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY repository secrets.
#
#   terraform init
#   terraform apply \
#     -var 'state_bucket_name=<TF_STATE_BUCKET>' \
#     -var 'golden_image_repository_arns=["arn:aws:ecr:<region>:<account>:repository/<backend>", "arn:aws:ecr:<region>:<account>:repository/<frontend>"]'
#
# Cutover, in this order:
#   1. Set the `role_arn` output as the repository variable
#      AWS_PLATFORM_DEPLOY_ROLE_ARN (Settings > Secrets and variables >
#      Actions > Variables).
#   2. Run one AWS deploy, one Azure deploy and one teardown.
#   3. Only then delete the AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY
#      repository secrets. Once the platform application also runs on its
#      own role (infra/platform/control-plane), nothing uses that IAM user's
#      key: deactivate it, then delete the user.
#
# State stays local on purpose: this root is applied once and changed rarely,
# and *.tfstate is gitignored. The state holds resource IDs, not secrets.
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
  github_oidc_url = "https://token.actions.githubusercontent.com"

  # The only subject allowed to assume the platform role: workflow runs on the
  # deploy branch of this repository. src/lib/deploy.ts dispatches every
  # workflow on CHATBOT_DEPLOY_REF, so that is the ref the token carries. A
  # wildcard here would let anyone able to push any branch hold a role that
  # can assume every customer's deployment role.
  github_subject = "repo:${var.github_owner}/${var.github_repo}:ref:refs/heads/${var.deploy_ref}"

  oidc_provider_arn = (
    var.create_oidc_provider
    ? one(aws_iam_openid_connect_provider.github[*].arn)
    : one(data.aws_iam_openid_connect_provider.github[*].arn)
  )
}

# An account can hold only one provider per issuer URL. If GitHub's is already
# registered for another purpose, set create_oidc_provider = false to reuse it.
resource "aws_iam_openid_connect_provider" "github" {
  count = var.create_oidc_provider ? 1 : 0

  url            = local.github_oidc_url
  client_id_list = ["sts.amazonaws.com"]
  # No thumbprint_list: AWS verifies GitHub's OIDC endpoint against its own
  # trusted certificate authorities, and the attribute is optional in this
  # provider version.
}

data "aws_iam_openid_connect_provider" "github" {
  count = var.create_oidc_provider ? 0 : 1
  url   = local.github_oidc_url
}

data "aws_iam_policy_document" "trust" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [local.oidc_provider_arn]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }

    # StringEquals rather than StringLike: the subject must match exactly.
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values   = [local.github_subject]
    }
  }
}

resource "aws_iam_role" "github_deploy" {
  name                 = var.role_name
  description          = "Assumed by GitHub Actions through OIDC for tenant deploys and teardowns. No tenant document or data access."
  assume_role_policy   = data.aws_iam_policy_document.trust.json
  max_session_duration = 3600
}

data "aws_iam_policy_document" "permissions" {
  # Registry login. AWS does not allow this action to be scoped to a repository.
  statement {
    sid       = "EcrLogin"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }

  # Pull the golden images, and nothing else in the registry.
  statement {
    sid = "PullGoldenImages"
    actions = [
      "ecr:BatchCheckLayerAvailability",
      "ecr:BatchGetImage",
      "ecr:GetDownloadUrlForLayer",
    ]
    resources = var.golden_image_repository_arns
  }

  # Terraform's S3 backend lists the bucket; HashiCorp's documented minimum
  # grants ListBucket on the bucket itself.
  statement {
    sid       = "StateBucketList"
    actions   = ["s3:ListBucket"]
    resources = ["arn:aws:s3:::${var.state_bucket_name}"]
  }

  # State objects for Azure tenants only. AWS tenant deploys reach their state
  # as the customer's own role, through the bucket's existing per-account
  # grants, so this role never needs the tenants/ prefix.
  statement {
    sid       = "AzureTenantState"
    actions   = ["s3:GetObject", "s3:PutObject"]
    resources = ["arn:aws:s3:::${var.state_bucket_name}/azure/tenants/*"]
  }

  # Assume customer deployment roles, and only those, matching the naming
  # restriction customers are told to follow (see SECURITY.md).
  statement {
    sid       = "AssumeCustomerDeploymentRoles"
    actions   = ["sts:AssumeRole"]
    resources = ["arn:aws:iam::*:role/chatbot-client-deploy-*"]
  }

  dynamic "statement" {
    for_each = var.state_bucket_kms_key_arn == "" ? [] : [1]
    content {
      sid       = "StateBucketKms"
      actions   = ["kms:Decrypt", "kms:Encrypt", "kms:GenerateDataKey"]
      resources = [var.state_bucket_kms_key_arn]
    }
  }
}

resource "aws_iam_role_policy" "github_deploy" {
  name   = "platform-deploy"
  role   = aws_iam_role.github_deploy.id
  policy = data.aws_iam_policy_document.permissions.json
}
