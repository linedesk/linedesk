ALTER TABLE "assistants" ADD COLUMN "talking_speed_pct" integer DEFAULT 100 NOT NULL;--> statement-breakpoint
-- Slow and fast were 90 and 110 percent of the voice's own pace in the voice agent.
UPDATE "assistants" SET "talking_speed_pct" = CASE "talking_speed" WHEN 'slow' THEN 90 WHEN 'fast' THEN 110 ELSE 100 END;
