CREATE TABLE "assistant_calendars" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"assistant_id" text NOT NULL,
	"connection_id" text NOT NULL,
	"external_id" text NOT NULL,
	"name" text NOT NULL,
	"instruction" text DEFAULT '' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" bigint DEFAULT nextval('row_version') NOT NULL,
	CONSTRAINT "assistant_calendars_calendar" UNIQUE("assistant_id","connection_id","external_id")
);
--> statement-breakpoint
CREATE TABLE "calendar_connections" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"provider" text NOT NULL,
	"account_email" text NOT NULL,
	"status" text DEFAULT 'connected' NOT NULL,
	"last_error" text,
	"connected_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" bigint DEFAULT nextval('row_version') NOT NULL,
	CONSTRAINT "calendar_connections_account" UNIQUE("workspace_id","provider","account_email")
);
--> statement-breakpoint
CREATE TABLE "calendar_credentials" (
	"connection_id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"access_token_encrypted" text NOT NULL,
	"refresh_token_encrypted" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"scope" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "calendar_oauth_states" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"provider" text NOT NULL,
	"code_verifier" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "title" text;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "calendar_name" text;--> statement-breakpoint
ALTER TABLE "assistant_calendars" ADD CONSTRAINT "assistant_calendars_assistant_id_assistants_id_fk" FOREIGN KEY ("assistant_id") REFERENCES "public"."assistants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_calendars" ADD CONSTRAINT "assistant_calendars_connection_id_calendar_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."calendar_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_credentials" ADD CONSTRAINT "calendar_credentials_connection_id_calendar_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."calendar_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "assistant_calendars_ws" ON "assistant_calendars" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "calendar_connections_ws" ON "calendar_connections" USING btree ("workspace_id");--> statement-breakpoint
create trigger calendar_connections_version before update on calendar_connections for each row execute function bump_row_version();--> statement-breakpoint
create trigger assistant_calendars_version before update on assistant_calendars for each row execute function bump_row_version();
