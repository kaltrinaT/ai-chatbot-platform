#!/usr/bin/env bash
# Initialises Terraform for one AWS tenant against the state bucket in the
# tenant's own account, and moves the tenant's state there from the
# platform's bucket the first time it runs for a tenant deployed before that
# bucket existed.
#
# Run by deploy-tenant.yml and destroy-tenant.yml from infra/terraform, with
# the customer's deployment role already assumed. Environment:
#
#   TENANT_SLUG, AWS_ACCOUNT_ID, TENANT_REGION
#       Identify the tenant's state bucket. Its name must match the one the
#       bootstrap stack creates (infra/bootstrap/aws/tenant-bootstrap.yaml)
#       and awsStateBucketName in src/lib/bootstrapLinks.ts.
#   LEGACY_STATE_BUCKET, LEGACY_STATE_REGION
#       The platform's old shared state bucket. Unset them once every AWS
#       tenant's state has moved (SECURITY.md, Known Limitation #9).
#
# It fails closed. The one outcome it must never allow is Terraform starting
# from empty state for a tenant whose infrastructure already exists: a deploy
# would then try to create everything a second time, and a teardown would
# report success while deleting nothing. So it proceeds only on a definite
# answer about where the state is, and stops on anything else.
set -euo pipefail

bucket="tfstate-${TENANT_SLUG}-${AWS_ACCOUNT_ID}-${TENANT_REGION}-an"
key="terraform.tfstate"
legacy_key="tenants/${TENANT_SLUG}.tfstate"

# Prints "present" or "absent" for one state object, or stops the run when S3
# answers anything that is not a clear yes or no — a missing permission must
# never be read as "no state here".
state_status() {
  local b="$1" k="$2" region="$3" err
  if err="$(aws s3api head-object --bucket "$b" --key "$k" --region "$region" 2>&1 >/dev/null)"; then
    echo present
  elif grep -q '(404)' <<<"$err"; then
    echo absent
  else
    echo "::error title=Could not tell whether Terraform state exists::s3://$b/$k answered: $err" >&2
    exit 1
  fi
}

init_backend() {
  local b="$1" region="$2" k="$3"
  shift 3
  terraform init -input=false \
    -backend-config="bucket=$b" \
    -backend-config="region=$region" \
    -backend-config="key=$k" \
    -backend-config="encrypt=true" \
    "$@"
}

# What the state says about itself, without printing any of its values.
state_fingerprint() {
  aws s3 cp "s3://$1/$2" - --region "$3" --only-show-errors |
    jq -c '{lineage, resources: (.resources | length)}'
}

# The bucket is created by the tenant's bootstrap stack. Its name lies in the
# account's own regional namespace, so no other account can hold it; the
# owner check is a second, independent guarantee.
if ! err="$(aws s3api head-bucket --bucket "$bucket" --expected-bucket-owner "$AWS_ACCOUNT_ID" --region "$TENANT_REGION" 2>&1 >/dev/null)"; then
  echo "::error title=Terraform state bucket missing::s3://$bucket was not found in account $AWS_ACCOUNT_ID. The tenant's bootstrap stack creates it: update an existing stack to the current template (the tenant page shows the command), or create the stack, then run this again. S3 said: $err" >&2
  exit 1
fi

current="$(state_status "$bucket" "$key" "$TENANT_REGION")"
legacy=absent
if [ -n "${LEGACY_STATE_BUCKET:-}" ]; then
  legacy="$(state_status "$LEGACY_STATE_BUCKET" "$legacy_key" "$LEGACY_STATE_REGION")"
fi

case "$current:$legacy" in
  absent:present)
    echo "::notice title=Moving Terraform state into the customer's account::s3://$LEGACY_STATE_BUCKET/$legacy_key to s3://$bucket/$key"
    init_backend "$LEGACY_STATE_BUCKET" "$LEGACY_STATE_REGION" "$legacy_key"
    init_backend "$bucket" "$TENANT_REGION" "$key" -backend-config="use_lockfile=true" -migrate-state -force-copy

    # Nothing runs against the new copy until it is shown to be the same state.
    before="$(state_fingerprint "$LEGACY_STATE_BUCKET" "$legacy_key" "$LEGACY_STATE_REGION")"
    after="$(state_fingerprint "$bucket" "$key" "$TENANT_REGION")"
    if [ "$before" != "$after" ]; then
      echo "::error title=Terraform state did not copy intact::platform bucket $before, customer bucket $after. The platform's copy is untouched." >&2
      exit 1
    fi
    echo "Moved Terraform state intact: $after"
    ;;
  present:present)
    init_backend "$bucket" "$TENANT_REGION" "$key" -backend-config="use_lockfile=true"
    echo "::warning title=Old Terraform state still in the platform bucket::s3://$LEGACY_STATE_BUCKET/$legacy_key is a superseded copy and still holds this tenant's old secrets. Delete it and all its versions (SECURITY.md, Known Limitation #9)."
    ;;
  *)
    # Already moved, or a tenant deploying for the first time.
    init_backend "$bucket" "$TENANT_REGION" "$key" -backend-config="use_lockfile=true"
    ;;
esac
