CREATE TYPE "public"."document_status" AS ENUM('pending', 'uploaded', 'failed');--> statement-breakpoint
CREATE TABLE "tenant_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"object_key" text NOT NULL,
	"display_name" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" integer,
	"status" "document_status" DEFAULT 'pending' NOT NULL,
	"uploaded_by_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "docs_signer_secret_arn" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "docs_signer_secret_encrypted" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "docs_signer_url" text;--> statement-breakpoint
ALTER TABLE "tenant_documents" ADD CONSTRAINT "tenant_documents_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_documents" ADD CONSTRAINT "tenant_documents_uploaded_by_user_id_users_id_fk" FOREIGN KEY ("uploaded_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;