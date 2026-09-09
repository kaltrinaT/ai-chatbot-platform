--> IF EXISTS added by hand. An earlier run of this same drop was applied to
--> the development database before the migration file was regenerated, so on
--> that database the columns are already gone and a bare DROP COLUMN would
--> fail with 42703. On a fresh database both columns exist (added by 0006 and
--> 0007) and are dropped normally.
ALTER TABLE "tenants" DROP COLUMN IF EXISTS "environment_label";--> statement-breakpoint
ALTER TABLE "tenants" DROP COLUMN IF EXISTS "description";
