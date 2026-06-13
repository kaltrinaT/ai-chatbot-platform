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
