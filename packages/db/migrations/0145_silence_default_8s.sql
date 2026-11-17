ALTER TABLE "assistants" ALTER COLUMN "silence_first_gap_s" SET DEFAULT 8;--> statement-breakpoint
ALTER TABLE "assistants" ALTER COLUMN "silence_hang_up_s" SET DEFAULT 24;--> statement-breakpoint
-- Assistants still on the old defaults (asked at 5 and 10 s, hang-up at 15 s) get the new ones: asked at 8 and 16 s, hang-up at 24 s.
UPDATE "assistants" SET "silence_first_gap_s" = 8, "silence_hang_up_s" = 24 WHERE "silence_first_gap_s" = 5 AND "silence_reminders" = 2 AND "silence_hang_up_s" = 15;
