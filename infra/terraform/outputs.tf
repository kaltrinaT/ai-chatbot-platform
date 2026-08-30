output "alb_dns_name" {
  description = "Public DNS name of the ALB; chatbot is reachable here over HTTP."
  value       = aws_lb.this.dns_name
}

output "chatbot_url" {
  description = "Full URL the workflow POSTs back to the platform's status webhook."
  value       = var.domain != "" ? "https://${var.domain}" : "http://${aws_lb.this.dns_name}"
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
