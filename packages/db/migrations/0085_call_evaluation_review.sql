ALTER TABLE "call_evaluations" ADD COLUMN "unanswered" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "call_evaluations" ADD COLUMN "reviewed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "call_evaluations" ADD COLUMN "reviewed_by" text;