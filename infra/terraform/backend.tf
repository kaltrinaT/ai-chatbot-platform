terraform {
  # Bucket / region / key are passed via `-backend-config=` at init time by
  # .github/scripts/terraform-init-aws.sh. State lives in the customer's own
  # account, in the bucket their bootstrap stack creates
  # (tfstate-<slug>-<account>-<region>-an), locked with an S3 lock file
  # (use_lockfile, Terraform >= 1.11).
  backend "s3" {}
}
