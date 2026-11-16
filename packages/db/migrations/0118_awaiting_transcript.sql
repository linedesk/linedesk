ALTER TABLE "calls" ADD COLUMN "awaiting_transcript_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN "transcript_requested_at" timestamp with time zone;