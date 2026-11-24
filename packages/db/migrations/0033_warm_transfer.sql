ALTER TABLE "assistants" ADD COLUMN "transfer_urgent" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "assistants" ADD COLUMN "transfer_number" text;--> statement-breakpoint
ALTER TABLE "assistants" ADD COLUMN "transfer_hours_only" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN "transfer_to" text;--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN "transfer_result" text;--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN "transfer_at" timestamp with time zone;