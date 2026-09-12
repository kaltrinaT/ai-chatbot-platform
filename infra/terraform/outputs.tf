output "alb_dns_name" {
  description = "Public DNS name of the ALB; chatbot is reachable here over HTTP."
  value       = aws_lb.this.dns_name
}

output "chatbot_url" {
  description = <<-EOT
    Full URL the workflow POSTs back to the platform's status webhook.

    The scheme is whatever the ALB will actually answer on. This used to
    report https:// for any tenant with a custom domain, whether or not a
    certificate existed — and none ever did, so the advertised URL pointed at
    a port the load balancer was not listening on.
  EOT
  value = (
    local.enable_https && var.domain != "" ? "https://${var.domain}" :
    local.use_cdn ? "https://${one(aws_cloudfront_distribution.this[*].domain_name)}" :
    var.domain != "" ? "http://${var.domain}" :
    "http://${aws_lb.this.dns_name}"
  )
}

output "cdn_domain_name" {
  description = "CloudFront hostname serving this tenant over HTTPS, or empty when the tenant terminates TLS at its own load balancer instead."
  value       = local.use_cdn ? one(aws_cloudfront_distribution.this[*].domain_name) : ""
}

output "ecs_cluster_name" {
  value = aws_ecs_cluster.this.name
}

output "ecs_service_name" {
  value = aws_ecs_service.this.name
}

output "log_group" {
  value = aws_cloudwatch_log_group.this.name
}

output "docs_signer_url" {
  description = "Function URL of the docs-signer Lambda. The platform calls this over plain HTTPS for document upload/delete — it never calls AWS directly for documents."
  value       = aws_lambda_function_url.docs_signer.function_url
}
