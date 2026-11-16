CREATE TABLE "email_recipients" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"email" text NOT NULL,
	"label" text,
	"confirmed_at" timestamp with time zone,
	"stopped_at" timestamp with time zone,
	"confirm_token_hash" text,
	"confirm_expires_at" timestamp with time zone,
	"confirm_sent_at" timestamp with time zone,
	"removed_at" timestamp with time zone,
	"added_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" bigint DEFAULT nextval('row_version') NOT NULL,
	CONSTRAINT "email_recipients_ws_email" UNIQUE("workspace_id","email")
);
--> statement-breakpoint
ALTER TABLE "assistants" ADD COLUMN "email_routing" text;--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN "email_route" jsonb;--> statement-breakpoint
CREATE INDEX "email_recipients_ws" ON "email_recipients" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "email_recipients_token" ON "email_recipients" USING btree ("confirm_token_hash");--> statement-breakpoint
create trigger email_recipients_version before update on email_recipients for each row execute function bump_row_version();
