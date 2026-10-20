# Masks credentials in Terraform's output before it reaches a public Actions log.
#
# Every Terraform apply and destroy in deploy-tenant.yml, destroy-tenant.yml,
# deploy-tenant-azure.yml and destroy-tenant-azure.yml runs as
#
#   set -o pipefail
#   terraform ... 2>&1 | sed -u -E -f "$GITHUB_WORKSPACE/.github/scripts/redact-secrets.sed"
#
# Terraform hides what the provider or a sensitive variable marks, and every
# secret this platform passes in is marked. What it cannot hide is a value a
# provider does not mark: azurerm prints a Function App's app_settings, and
# Azure/functions-action writes the package URL, with a year-long read SAS,
# into them. A destroy printed it twice (runs 37132196910 and 39132033807).
# This filter is the second line: it masks the credential formats the
# platform handles wherever they appear, so a provider change or a new
# resource cannot put one in a log unnoticed. Each rule keeps what identifies
# the value and replaces only the secret part. src/lib/deployPipeline.test.ts
# runs every rule against every workflow's Terraform steps.

# Azure SAS signature: ?...&sig=<signature>
s/([?&]sig=)[^&"[:space:]]+/\1***/g
# AWS SigV4 query authentication: a presigned URL's signature, credential and session token
s/([?&]X-Amz-(Signature|Credential|Security-Token)=)[^&"[:space:]]+/\1***/gI
# A password inside a URL: scheme://user:password@host
s#(://[^/:@"[:space:]]+:)[^@/"[:space:]]+@#\1***@#g
# OpenRouter API key
s/sk-or-v1-[a-f0-9]{64}/sk-or-v1-***/g
# Pinecone API key
s/pcsk_[A-Za-z0-9_]{20,}/pcsk_***/g
# AWS access key id (the secret key has no prefix; the provider marks it)
s/\b(AKIA|ASIA)[A-Z0-9]{16}\b/\1***/g
# GitHub tokens
s/\b(gh[pousr]_)[A-Za-z0-9]{36,}/\1***/g
s/\bgithub_pat_[A-Za-z0-9_]{22,}/github_pat_***/g
