#!/usr/bin/env bash
# Initialises Terraform for one Azure tenant against the state storage
# account in the tenant's own subscription, and moves the tenant's state
# there from the platform's S3 bucket the first time it runs for a tenant
# deployed before that account existed.
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
#   LEGACY_STATE_BUCKET, LEGACY_STATE_REGION
#       The platform's old shared S3 bucket, read with the platform role's
#       credentials from the job environment. Unset them once every Azure
#       tenant's state has moved (SECURITY.md, Known Limitation #9).
#
# It fails closed, for the same reason as terraform-init-aws.sh: Terraform
# must never start from empty state for a tenant whose infrastructure
# exists. It proceeds only on a definite answer about where the state is.
set -euo pipefail

resource_group="chatbot-${TENANT_SLUG}"
account="cbtf${TENANT_SLUG//-/}"
container="tfstate"
key="terraform.tfstate"
legacy_key="azure/tenants/${TENANT_SLUG}/terraform.tfstate"

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

# Prints true or false from one `az ... --query exists` call, or stops the
# run on anything else — a missing permission must never be read as "no".
exists() {
  local what="$1" value
  shift
  if ! value="$(az "$@" --auth-mode login --account-name "$account" --query exists --output tsv 2>"$work/err")"; then
    fail "Could not tell whether $what exists" "$account answered: $(head -c 300 "$work/err")"
  fi
  case "$value" in
    true | false) echo "$value" ;;
    *) fail "Could not tell whether $what exists" "$account gave an unexpected answer: $value" ;;
  esac
}

# Each answer is assigned before it is used. A failure inside `$(...)` exits
# only that subshell; in an assignment, set -e stops the script, but used
# directly in a test or a case it would leave an empty answer that reads as
# "false" — a permission error taken for "no state".
container_found="$(exists "the state container" storage container exists --name "$container")"
if [ "$container_found" != true ]; then
  fail "Terraform state container missing" \
    "Container $container was not found in $account. Run the tenant's bootstrap again, which creates it, then run this again."
fi

state_found="$(exists "Terraform state" storage blob exists --container-name "$container" --name "$key")"
if [ "$state_found" = true ]; then
  current=present
else
  current=absent
fi

# The platform's old copy, if there is still a bucket to look in. The same
# rule applies: only S3's own "404 Not Found" counts as absent.
legacy=absent
if [ -n "${LEGACY_STATE_BUCKET:-}" ]; then
  if aws s3api head-object --bucket "$LEGACY_STATE_BUCKET" --key "$legacy_key" \
    --region "$LEGACY_STATE_REGION" >/dev/null 2>"$work/err"; then
    legacy=present
  elif ! grep -q '(404)' "$work/err"; then
    fail "Could not tell whether Terraform state exists" \
      "s3://$LEGACY_STATE_BUCKET/$legacy_key answered: $(head -c 300 "$work/err")"
  fi
fi

# What a state file says about itself, without printing any of its values.
fingerprint() {
  jq -c '{lineage, resources: (.resources | length)}' "$1"
}

if [ "$current:$legacy" = "absent:present" ]; then
  echo "::notice title=Moving Terraform state into the customer's subscription::s3://$LEGACY_STATE_BUCKET/$legacy_key to $account/$container/$key"
  aws s3 cp "s3://$LEGACY_STATE_BUCKET/$legacy_key" "$work/platform.tfstate" \
    --region "$LEGACY_STATE_REGION" --only-show-errors
  # Refuses to overwrite: if a state blob appeared since the check above,
  # the upload fails rather than replacing it.
  az storage blob upload --auth-mode login --account-name "$account" \
    --container-name "$container" --name "$key" --file "$work/platform.tfstate" \
    --only-show-errors >/dev/null

  # Nothing runs against the new copy until it is shown to be the same state.
  az storage blob download --auth-mode login --account-name "$account" \
    --container-name "$container" --name "$key" --file "$work/customer.tfstate" \
    --only-show-errors >/dev/null
  before="$(fingerprint "$work/platform.tfstate")"
  after="$(fingerprint "$work/customer.tfstate")"
  if [ "$before" != "$after" ]; then
    fail "Terraform state did not copy intact" \
      "platform bucket $before, customer account $after. The platform's copy is untouched."
  fi
  echo "Moved Terraform state intact: $after"
elif [ "$current:$legacy" = "present:present" ]; then
  echo "::warning title=Old Terraform state still in the platform bucket::s3://$LEGACY_STATE_BUCKET/$legacy_key is a superseded copy and still holds this tenant's old secrets. Delete it and all its versions (SECURITY.md, Known Limitation #9)."
fi

# Locked for the length of each run: the backend takes a lease on the blob.
terraform init -input=false \
  -backend-config="storage_account_name=$account" \
  -backend-config="container_name=$container" \
  -backend-config="key=$key" \
  -backend-config="tenant_id=$AZURE_TENANT_ID" \
  -backend-config="client_id=$AZURE_CLIENT_ID" \
  -backend-config="use_oidc=true" \
  -backend-config="use_azuread_auth=true"
