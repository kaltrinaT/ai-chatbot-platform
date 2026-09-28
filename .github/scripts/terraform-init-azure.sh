#!/usr/bin/env bash
# Initialises Terraform for one Azure tenant against the state storage
# account in the tenant's own subscription, locked with a blob lease for the
# length of the run.
#
# Run by deploy-tenant-azure.yml and destroy-tenant-azure.yml from
# infra/terraform/azure, after `az login` into the customer's subscription.
# Environment:
#
#   TENANT_SLUG
#       Identifies the tenant's resource group (chatbot-<slug>) and state
#       storage account (cbtf<slug without hyphens>). Must match the bootstrap
#       template (infra/bootstrap/azure/tenant-bootstrap.json) and
#       azureStateStorageAccountName in src/lib/bootstrapLinks.ts.
#   AZURE_SUBSCRIPTION_ID, AZURE_TENANT_ID, AZURE_CLIENT_ID
#       The customer's subscription and deployment identity. Terraform's
#       backend signs in as that identity with the run's GitHub OIDC token.
#
# This account is the only place a tenant's state is kept.
set -euo pipefail

resource_group="chatbot-${TENANT_SLUG}"
account="cbtf${TENANT_SLUG//-/}"
container="tfstate"
key="terraform.tfstate"

umask 077
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

fail() {
  echo "::error title=$1::$2" >&2
  exit 1
}

# The state account must be the one in this tenant's own resource group. A
# storage account name is global, so only an account found there, through
# the management plane, is ever used.
if ! az storage account show --resource-group "$resource_group" --name "$account" \
  --subscription "$AZURE_SUBSCRIPTION_ID" --query id --output tsv >/dev/null 2>"$work/err"; then
  fail "Terraform state storage account missing" \
    "Storage account $account was not found in resource group $resource_group. The tenant's bootstrap creates it: run the bootstrap again (the tenant page shows the command), then run this again. Azure said: $(head -c 300 "$work/err")"
fi

# The answer is assigned before it is used. A failure inside `$(...)` exits
# only that subshell; in an assignment, set -e stops the script, but used
# directly in a test it would leave an empty answer that reads as "false" —
# a missing data role taken for a missing container.
if ! container_found="$(az storage container exists --name "$container" --auth-mode login \
  --account-name "$account" --query exists --output tsv 2>"$work/err")"; then
  fail "Could not tell whether the state container exists" "$account answered: $(head -c 300 "$work/err")"
fi
case "$container_found" in
  true) ;;
  false)
    fail "Terraform state container missing" \
      "Container $container was not found in $account. Run the tenant's bootstrap again, which creates it, then run this again." ;;
  *) fail "Could not tell whether the state container exists" "$account gave an unexpected answer: $container_found" ;;
esac

# Locked for the length of each run: the backend takes a lease on the blob.
terraform init -input=false \
  -backend-config="storage_account_name=$account" \
  -backend-config="container_name=$container" \
  -backend-config="key=$key" \
  -backend-config="tenant_id=$AZURE_TENANT_ID" \
  -backend-config="client_id=$AZURE_CLIENT_ID" \
  -backend-config="use_oidc=true" \
  -backend-config="use_azuread_auth=true"
