ALTER TABLE "assistants" ADD COLUMN "greeting_outside" text;--> statement-breakpoint
ALTER TABLE "assistants" ADD COLUMN "instructions_outside" text;--> statement-breakpoint
ALTER TABLE "workspace_settings" ADD COLUMN "business_hours_on" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- Workspaces that already set hours keep using them; for everyone else hours are off until turned on.
UPDATE "workspace_settings" SET "business_hours_on" = true WHERE "workspace_id" IN (SELECT DISTINCT "workspace_id" FROM "availability_rules");
