CREATE TYPE "public"."vector_store" AS ENUM('pinecone', 'pgvector');--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "vector_store" vector_store DEFAULT 'pinecone' NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "pinecone_api_key_encrypted" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "pinecone_secret_arn" text;