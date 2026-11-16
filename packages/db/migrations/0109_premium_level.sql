ALTER TABLE "assistants" ALTER COLUMN "max_call_minutes" SET DEFAULT 20;--> statement-breakpoint
ALTER TABLE "assistants" ADD COLUMN "llm_model" text;--> statement-breakpoint
ALTER TABLE "workspace_settings" ADD COLUMN "allow_premium" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- Before go-live (no real customers yet): assistants on the old default of 25 minutes get the new default of 20.
UPDATE "assistants" SET "max_call_minutes" = 20 WHERE "max_call_minutes" = 25;--> statement-breakpoint
-- The longest call is 30 minutes now (ASSISTANT_CALL_MAX_MINUTES): a longer one set before is cut to 30, so the check holds.
UPDATE "assistants" SET "max_call_minutes" = 30 WHERE "max_call_minutes" > 30;--> statement-breakpoint
UPDATE "assistants" SET "max_call_minutes" = 1 WHERE "max_call_minutes" < 1;--> statement-breakpoint
ALTER TABLE "assistants" ADD CONSTRAINT "assistants_max_call_minutes" CHECK ("assistants"."max_call_minutes" between 1 and 30);
