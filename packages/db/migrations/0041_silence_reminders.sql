ALTER TABLE "assistants" ADD COLUMN "silence_first_gap_s" integer DEFAULT 8 NOT NULL;--> statement-breakpoint
ALTER TABLE "assistants" ADD COLUMN "silence_reminders" integer DEFAULT 2 NOT NULL;--> statement-breakpoint
ALTER TABLE "assistants" ADD COLUMN "silence_closing" text;