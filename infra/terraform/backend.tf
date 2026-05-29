terraform {
  # Bucket / region / key are passed via `-backend-config=` at init time
  # from .github/workflows/deploy-tenant.yml. State is stored per-tenant
  # under tenants/<slug>.tfstate in the platform-owned S3 bucket.
  backend "s3" {}
}
