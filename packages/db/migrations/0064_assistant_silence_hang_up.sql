ALTER TABLE "assistants" ALTER COLUMN "silence_first_gap_s" SET DEFAULT 5;--> statement-breakpoint
ALTER TABLE "assistants" ADD COLUMN "silence_hang_up_s" integer DEFAULT 15 NOT NULL;--> statement-breakpoint
-- Assistants still on the old defaults (first wait 8 s, asked twice) get the new ones: asked at 5 and 10 s, hang-up at 15 s.
UPDATE "assistants" SET "silence_first_gap_s" = 5 WHERE "silence_first_gap_s" = 8 AND "silence_reminders" = 2;
