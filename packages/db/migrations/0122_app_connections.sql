CREATE TABLE "app_connections" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"provider" text NOT NULL,
	"account_id" text NOT NULL,
	"account_name" text NOT NULL,
	"status" text DEFAULT 'connected' NOT NULL,
	"error_code" text,
	"failures" integer DEFAULT 0 NOT NULL,
	"last_push_at" timestamp with time zone,
	"connected_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" bigint DEFAULT nextval('row_version') NOT NULL,
	CONSTRAINT "app_connections_app" UNIQUE("workspace_id","provider")
);
--> statement-breakpoint
CREATE TABLE "app_credentials" (
	"connection_id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"access_token_encrypted" text NOT NULL,
	"refresh_token_encrypted" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"scope" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app_oauth_states" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"provider" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app_pushes" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"connection_id" text NOT NULL,
	"call_id" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"claimed_at" timestamp with time zone,
	"error_code" text,
	"record_id" text,
	"external_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "app_pushes_call" UNIQUE("connection_id","call_id")
);
--> statement-breakpoint
CREATE TABLE "crm_links" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"connection_id" text NOT NULL,
	"contact_id" text NOT NULL,
	"external_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "crm_links_contact" UNIQUE("connection_id","contact_id")
);
--> statement-breakpoint
ALTER TABLE "app_credentials" ADD CONSTRAINT "app_credentials_connection_id_app_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."app_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_pushes" ADD CONSTRAINT "app_pushes_connection_id_app_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."app_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_pushes" ADD CONSTRAINT "app_pushes_call_id_calls_id_fk" FOREIGN KEY ("call_id") REFERENCES "public"."calls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_links" ADD CONSTRAINT "crm_links_connection_id_app_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."app_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_links" ADD CONSTRAINT "crm_links_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "app_connections_ws" ON "app_connections" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "app_pushes_connection" ON "app_pushes" USING btree ("connection_id","created_at");--> statement-breakpoint
CREATE INDEX "app_pushes_open" ON "app_pushes" USING btree ("created_at") WHERE "app_pushes"."status" in ('pending', 'sending');--> statement-breakpoint
CREATE INDEX "crm_links_ws" ON "crm_links" USING btree ("workspace_id");--> statement-breakpoint
create trigger app_connections_version before update on app_connections for each row execute function bump_row_version();
