ALTER TABLE "feedback" DROP CONSTRAINT "feedback_status";--> statement-breakpoint
ALTER TABLE "feedback" ALTER COLUMN "workspace_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_setup_keys" ADD COLUMN "client" text;--> statement-breakpoint
ALTER TABLE "feedback" ADD COLUMN "setup_key_id" text;--> statement-breakpoint
ALTER TABLE "feedback" ADD COLUMN "report" jsonb;--> statement-breakpoint
ALTER TABLE "feedback" ADD COLUMN "remote_id" text;--> statement-breakpoint
ALTER TABLE "feedback" ADD COLUMN "tries" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "feedback" ADD COLUMN "tried_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "feedback_setup_key" ON "feedback" USING btree ("setup_key_id");--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_status" CHECK ("feedback"."status" in ('pending', 'sent', 'kept', 'failed', 'refused'));