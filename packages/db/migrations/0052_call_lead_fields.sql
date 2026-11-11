CREATE TABLE "custom_fields" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"label" text NOT NULL,
	"type" text NOT NULL,
	"options" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"ask_caller" boolean DEFAULT false NOT NULL,
	"instruction" text,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" bigint DEFAULT nextval('row_version') NOT NULL
);
--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN "caller_name" text;--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN "callback_number" text;--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN "address" text;--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN "job_type" text;--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN "tag" text;--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN "custom_values" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
CREATE INDEX "custom_fields_ws" ON "custom_fields" USING btree ("workspace_id");--> statement-breakpoint
create trigger custom_fields_version before update on custom_fields for each row execute function bump_row_version();