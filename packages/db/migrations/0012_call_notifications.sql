CREATE TABLE "member_notification_settings" (
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"email" boolean,
	"browser" boolean,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "member_notification_settings_workspace_id_user_id_pk" PRIMARY KEY("workspace_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "workspace_settings" ADD COLUMN "notify_email_default" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace_settings" ADD COLUMN "notify_browser_default" boolean DEFAULT true NOT NULL;