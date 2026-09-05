output "container_app_fqdn" {
  description = "Public FQDN of the Container App."
  value       = azurerm_container_app.this.ingress[0].fqdn
}

output "chatbot_url" {
  description = "Full URL posted back to the platform webhook."
  value       = var.domain != "" ? "https://${var.domain}" : "https://${azurerm_container_app.this.ingress[0].fqdn}"
}

output "acr_login_server" {
  value = azurerm_container_registry.this.login_server
}

output "key_vault_name" {
  value = azurerm_key_vault.this.name
}

output "resource_group_name" {
  value = azurerm_resource_group.this.name
}

output "storage_account_name" {
  value = azurerm_storage_account.docs.name
}

output "storage_container_name" {
  value = azurerm_storage_container.docs.name
}

output "docs_signer_url" {
  description = "Invoke URL of the docs-signer Function. anonymous authLevel means no Azure Functions key is required — auth is the shared-secret header, same model as the AWS Lambda Function URL."
  value       = "https://${azurerm_linux_function_app.docs_signer.default_hostname}/api/docs-signer"
}

output "docs_signer_function_app_name" {
  value = azurerm_linux_function_app.docs_signer.name
}
