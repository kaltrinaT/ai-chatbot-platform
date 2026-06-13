CREATE TYPE "public"."cloud_provider" AS ENUM('aws', 'azure');--> statement-breakpoint
ALTER TABLE "tenants" ALTER COLUMN "aws_account_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ALTER COLUMN "aws_region" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "tenants" ALTER COLUMN "aws_region" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ALTER COLUMN "deployment_role_arn" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ALTER COLUMN "s3_docs_bucket" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "cloud_provider" "cloud_provider" DEFAULT 'aws' NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "azure_subscription_id" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "azure_tenant_id" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "azure_client_id" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "azure_client_secret_encrypted" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "azure_resource_group" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "azure_region" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "azure_storage_account" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "azure_storage_container" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "azure_key_vault_name" text;