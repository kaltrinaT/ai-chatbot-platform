# ──────────────────────────────────────────────────────────────────────
# The platform application's AWS identity, in the platform's own AWS account
#
# Applied ONCE by the platform operator, like infra/platform/github-oidc. The
# application makes one AWS call as the platform: onboarding's sts:AssumeRole
# into a customer's chatbot-client-deploy-* role. Everything after that runs
# as the customer's role, so this role is allowed nothing else.
#
# No access key exists for it. The operator signs in with `aws login`, and the
# AWS SDK assumes this role from that session through two profiles in
# ~/.aws/config:
#
#   [profile platform-operator]          # `aws login` adds login_session
#   region = us-east-1
#
#   [profile platform-control-plane]
#   role_arn          = <role_arn output>
#   source_profile    = platform-operator
#   role_session_name = platform-control-plane-local
#   region            = us-east-1
#
# with AWS_PROFILE=platform-control-plane in the application's .env. An IAM
# Identity Center session can be the source profile instead, once the account
# belongs to an AWS Organization; add its role to operator_principal_arns.
#
#   terraform init
#   terraform apply -var 'operator_principal_arns=["arn:aws:iam::<account>:user/<operator>"]'
#
# State stays local on purpose, as in infra/platform/github-oidc.
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

data "aws_iam_policy_document" "trust" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "AWS"
      identifiers = var.operator_principal_arns
    }

    # Only temporary credentials carry a token issue time. A long-lived access
    # key belonging to a trusted operator is therefore refused, so a stored key
    # cannot quietly stand in for the sign-in session.
    condition {
      test     = "Null"
      variable = "aws:TokenIssueTime"
      values   = ["false"]
    }
  }
}

resource "aws_iam_role" "control_plane" {
  name                 = var.role_name
  description          = "Assumed by the platform application from an operator sign-in session, for onboarding's sts:AssumeRole into customer deployment roles. Nothing else."
  assume_role_policy   = data.aws_iam_policy_document.trust.json
  max_session_duration = 3600
}

data "aws_iam_policy_document" "permissions" {
  # The same restriction as the GitHub Actions role, and the name customers are
  # told to give their role (see SECURITY.md).
  statement {
    sid       = "AssumeCustomerDeploymentRoles"
    actions   = ["sts:AssumeRole"]
    resources = ["arn:aws:iam::*:role/chatbot-client-deploy-*"]
  }
}

resource "aws_iam_role_policy" "control_plane" {
  name   = "platform-control-plane"
  role   = aws_iam_role.control_plane.id
  policy = data.aws_iam_policy_document.permissions.json
}
