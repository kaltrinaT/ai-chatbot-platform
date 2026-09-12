output "role_arn" {
  description = "Set this as the repository variable AWS_PLATFORM_DEPLOY_ROLE_ARN."
  value       = aws_iam_role.github_deploy.arn
}

output "trusted_subject" {
  description = "The only OIDC subject allowed to assume the role. Check it against the branch the platform dispatches on before cutting over."
  value       = local.github_subject
}
