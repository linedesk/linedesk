ALTER TABLE "assistants" ADD COLUMN "ai_disclosure" text DEFAULT 'when_asked' NOT NULL;--> statement-breakpoint
ALTER TABLE "assistants" ADD COLUMN "communication_style" text DEFAULT 'standard' NOT NULL;--> statement-breakpoint
ALTER TABLE "assistants" ADD COLUMN "behaviours" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "assistants" ADD COLUMN "emergency_note" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "availability_exceptions" ADD COLUMN "name" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace_settings" ADD COLUMN "closure" jsonb;--> statement-breakpoint
UPDATE "assistants" SET "ai_disclosure" = CASE WHEN "disclose_ai" THEN 'at_start' ELSE 'when_asked' END;