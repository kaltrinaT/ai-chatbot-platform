CREATE TYPE "public"."deployment_kind" AS ENUM('deploy', 'destroy');--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN "kind" "deployment_kind" DEFAULT 'deploy' NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "deleted_at" timestamp with time zone;