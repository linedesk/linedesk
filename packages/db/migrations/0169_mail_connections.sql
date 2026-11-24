CREATE TABLE "mail_connections" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"provider" text NOT NULL,
	"account_email" text NOT NULL,
	"status" text DEFAULT 'connected' NOT NULL,
	"last_error" text,
	"connected_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" bigint DEFAULT nextval('row_version') NOT NULL,
	CONSTRAINT "mail_connections_account" UNIQUE("workspace_id","provider","account_email")
);
--> statement-breakpoint
CREATE TABLE "mail_credentials" (
	"connection_id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"access_token_encrypted" text NOT NULL,
	"refresh_token_encrypted" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"scope" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mail_oauth_states" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"provider" text NOT NULL,
	"code_verifier" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mail_credentials" ADD CONSTRAINT "mail_credentials_connection_id_mail_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."mail_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mail_connections_ws" ON "mail_connections" USING btree ("workspace_id");--> statement-breakpoint
create trigger mail_connections_version before update on mail_connections for each row execute function bump_row_version();
