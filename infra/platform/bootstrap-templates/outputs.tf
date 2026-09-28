output "template_base_url" {
  description = <<-EOT
    Set this as PLATFORM_BOOTSTRAP_TEMPLATE_BASE_URL in the platform
    application's environment. Without it the onboarding wizard falls back to
    the manual instructions instead of showing the one-click buttons.
  EOT
  value       = "https://${aws_s3_bucket.templates.bucket_regional_domain_name}"
}

output "aws_template_url" {
  description = "The CloudFormation template a Quick Create link points at."
  value       = "https://${aws_s3_bucket.templates.bucket_regional_domain_name}/aws/tenant-bootstrap.yaml"
}

output "azure_template_url" {
  description = "The ARM template a Deploy to Azure link points at."
  value       = "https://${aws_s3_bucket.templates.bucket_regional_domain_name}/azure/tenant-bootstrap.json"
}
