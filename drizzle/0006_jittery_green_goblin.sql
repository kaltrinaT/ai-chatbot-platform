CREATE TABLE "tenant_drafts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" text NOT NULL,
	"name" text,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"step" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "llm_temperature" real;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "llm_max_tokens" integer;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "embedding_model" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "retrieval_top_k" integer;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "chunk_size" integer;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "chunk_overlap" integer;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "environment_label" text;--> statement-breakpoint
ALTER TABLE "tenant_drafts" ADD CONSTRAINT "tenant_drafts_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;