# ──────────────────────────────────────────────────────────────────────
# The platform application's AWS identity, in the platform's own AWS account
#
# Applied ONCE by the platform operator, like infra/platform/github-oidc. The
# application makes one AWS call as the platform: onboarding's sts:AssumeRole
# into a customer's chatbot-client-deploy-* role. Everything after that runs
# as the customer's role, so this role is allowed nothing else.
#
# Two ways in, and no access key for either.
#
#   Hosted   Vercel signs a short OIDC token for each invocation, which the
#            application exchanges for this role (platformCredentials in
#            src/lib/aws.ts). Set vercel_team_slug and vercel_project_name
#            here, and PLATFORM_AWS_ROLE_ARN in the project's environment.
#            Only the named environment is trusted, so a preview deployment of
#            any branch cannot reach a customer's account.
#
#   Local    The operator signs in with `aws login`, and the SDK assumes this
#            role from that session through two profiles in ~/.aws/config:
#
#              [profile platform-operator]     # `aws login` adds login_session
#              region = us-east-1
#
#              [profile platform-control-plane]
#              role_arn          = <role_arn output>
#              source_profile    = platform-operator
#              role_session_name = platform-control-plane-local
#              region            = us-east-1
#
#            with AWS_PROFILE=platform-control-plane in .env.
#
#   terraform init
#   terraform apply \
#     -var 'operator_principal_arns=["arn:aws:iam::<account>:user/<operator>"]' \
#     -var 'vercel_team_slug=<team>' -var 'vercel_project_name=<project>'
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

locals {
  federate_from_vercel = var.vercel_team_slug != "" && var.vercel_project_name != ""

  # Vercel's defaults. Both are shown on the project's OIDC settings page;
  # override the variables if that page disagrees.
  vercel_issuer   = var.vercel_oidc_issuer != "" ? var.vercel_oidc_issuer : "https://oidc.vercel.com/${var.vercel_team_slug}"
  vercel_audience = var.vercel_oidc_audience != "" ? var.vercel_oidc_audience : "https://vercel.com/${var.vercel_team_slug}"

  # One environment only. Every branch gets a preview deployment, and a subject
  # that did not pin the environment would hand any of them a role that can
  # reach every customer's account.
  vercel_subject = "owner:${var.vercel_team_slug}:project:${var.vercel_project_name}:environment:${var.vercel_environment}"

  # IAM names OIDC condition keys after the issuer with its scheme stripped.
  vercel_condition_prefix = replace(local.vercel_issuer, "https://", "")

  vercel_provider_arn = (
    local.federate_from_vercel
    ? (var.create_vercel_oidc_provider
      ? one(aws_iam_openid_connect_provider.vercel[*].arn)
    : one(data.aws_iam_openid_connect_provider.vercel[*].arn))
    : ""
  )
}

# An account holds one provider per issuer URL. Each Vercel team has its own
# issuer, so this is separate from GitHub's in infra/platform/github-oidc.
resource "aws_iam_openid_connect_provider" "vercel" {
  count = local.federate_from_vercel && var.create_vercel_oidc_provider ? 1 : 0

  url            = local.vercel_issuer
  client_id_list = [local.vercel_audience]
}

data "aws_iam_openid_connect_provider" "vercel" {
  count = local.federate_from_vercel && !var.create_vercel_oidc_provider ? 1 : 0
  url   = local.vercel_issuer
}

data "aws_iam_policy_document" "trust" {
  statement {
    sid     = "OperatorSignInSession"
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

  dynamic "statement" {
    for_each = local.federate_from_vercel ? [1] : []
    content {
      sid     = "HostWorkloadIdentity"
      actions = ["sts:AssumeRoleWithWebIdentity"]

      principals {
        type        = "Federated"
        identifiers = [local.vercel_provider_arn]
      }

      condition {
        test     = "StringEquals"
        variable = "${local.vercel_condition_prefix}:aud"
        values   = [local.vercel_audience]
      }

      condition {
        test     = "StringEquals"
        variable = "${local.vercel_condition_prefix}:sub"
        values   = [local.vercel_subject]
      }
    }
  }
}

resource "aws_iam_role" "control_plane" {
  name                 = var.role_name
  description          = "Assumed by the platform application, from its host's workload identity or an operator sign-in session, for onboarding's sts:AssumeRole into customer deployment roles. Nothing else."
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
