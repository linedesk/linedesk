ALTER TABLE "assistants" ADD COLUMN "recording_notice_on" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "assistants" ADD COLUMN "recording_notice" text;--> statement-breakpoint
UPDATE "assistants" AS a SET "recording_notice_on" = ws."recording_notice_on", "recording_notice" = ws."recording_notice" FROM "workspace_settings" AS ws WHERE ws."workspace_id" = a."workspace_id";
