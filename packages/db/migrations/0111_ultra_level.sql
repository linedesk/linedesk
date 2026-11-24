ALTER TABLE "assistants" ADD COLUMN "realtime_model" text;--> statement-breakpoint
ALTER TABLE "workspace_settings" ADD COLUMN "allow_ultra" boolean DEFAULT false NOT NULL;