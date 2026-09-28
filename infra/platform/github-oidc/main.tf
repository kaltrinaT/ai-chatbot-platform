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

  # The subjects allowed to assume the platform role: jobs of this repository
  # running in a tenant's GitHub environment. Every deploy and teardown job
  # runs in environment tenant-<tenant id>, and GitHub then writes the
  # environment into the token's subject in place of the branch, so a
  # branch subject would refuse every run.
  #
  # This is a wildcard, and the branch cannot be checked alongside it: AWS
  # evaluates only the `sub` and `aud` claims of a GitHub token, and putting
  # the workflow ref into `sub` would change the subject every customer's
  # trust policy matches on. What makes the wildcard acceptable is what the
  # role can do (below): pull the golden images and read old Azure state
  # while it is moved. It can no longer assume any customer's role — each
  # customer's own role trusts one exact tenant subject instead.
  github_subject = "repo:${var.github_owner}/${var.github_repo}:environment:tenant-*"

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

    # StringLike for the tenant-* environment pattern above. Customer roles,
    # which are what reach a customer's account, match with StringEquals.
    condition {
      test     = "StringLike"
      variable = "token.actions.githubusercontent.com:sub"
      values   = [local.github_subject]
    }
  }
}

resource "aws_iam_role" "github_deploy" {
  name                 = var.role_name
  description          = "Assumed by GitHub Actions through OIDC to pull the golden images. No access to customer accounts, documents or data."
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

  # No Terraform state access. Every tenant's state lives in the customer's
  # own cloud (AWS tfstate-<slug>-<account>-<region>-an, Azure cbtf<slug>),
  # reached as the customer's identity, never as this role.
  #
  # No sts:AssumeRole. Deploys, teardowns and connection checks sign in to a
  # customer's role directly with the run's own OIDC token, which that role
  # trusts for one tenant's environment only. The only principal that still
  # assumes customer roles is the control-plane role, at onboarding
  # (infra/platform/control-plane).
}

resource "aws_iam_role_policy" "github_deploy" {
  name   = "platform-deploy"
  role   = aws_iam_role.github_deploy.id
  policy = data.aws_iam_policy_document.permissions.json
}
