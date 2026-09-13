output "role_arn" {
  description = "The role_arn for the platform-control-plane profile, and the PLATFORM_AWS_ROLE_ARN a hosted deployment federates to. See the top of main.tf."
  value       = aws_iam_role.control_plane.arn
}

output "host_federation" {
  description = "What the trust policy expects from the host, to compare against the project's OIDC settings page. Empty when only the operator sign-in path is configured."
  value = local.federate_from_vercel ? {
    issuer          = local.vercel_issuer
    audience        = local.vercel_audience
    trusted_subject = local.vercel_subject
  } : null
}
