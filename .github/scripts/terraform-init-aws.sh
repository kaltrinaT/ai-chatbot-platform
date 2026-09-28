#!/usr/bin/env bash
# Initialises Terraform for one AWS tenant against the state bucket in the
# tenant's own account, locked with an S3 lock file for the length of the run.
#
# Run by deploy-tenant.yml and destroy-tenant.yml from infra/terraform, with
# the customer's deployment role already assumed. Environment:
#
#   TENANT_SLUG, AWS_ACCOUNT_ID, TENANT_REGION
#       Identify the tenant's state bucket. Its name must match the one the
#       bootstrap stack creates (infra/bootstrap/aws/tenant-bootstrap.yaml)
#       and awsStateBucketName in src/lib/bootstrapLinks.ts.
#
# This bucket is the only place a tenant's state is kept. Whether the state
# object exists is Terraform's to decide: it starts from empty state only on
# S3's "not found", and stops on any other error, such as a missing permission.
set -euo pipefail

bucket="tfstate-${TENANT_SLUG}-${AWS_ACCOUNT_ID}-${TENANT_REGION}-an"

# The bucket is created by the tenant's bootstrap stack. Its name lies in the
# account's own regional namespace, so no other account can hold it; the
# owner check is a second, independent guarantee. Checked here because a
# missing bucket otherwise surfaces as a backend error that says nothing about
# the stack.
if ! err="$(aws s3api head-bucket --bucket "$bucket" --expected-bucket-owner "$AWS_ACCOUNT_ID" --region "$TENANT_REGION" 2>&1 >/dev/null)"; then
  echo "::error title=Terraform state bucket missing::s3://$bucket was not found in account $AWS_ACCOUNT_ID. The tenant's bootstrap stack creates it: update an existing stack to the current template (the tenant page shows the command), or create the stack, then run this again. S3 said: $err" >&2
  exit 1
fi

terraform init -input=false \
  -backend-config="bucket=$bucket" \
  -backend-config="region=$TENANT_REGION" \
  -backend-config="key=terraform.tfstate" \
  -backend-config="encrypt=true" \
  -backend-config="use_lockfile=true"
