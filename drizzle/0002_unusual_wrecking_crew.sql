ALTER TYPE "public"."llm_provider" ADD VALUE 'openrouter';--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "llm_model" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "llm_base_url" text;