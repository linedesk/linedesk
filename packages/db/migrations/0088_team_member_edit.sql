CREATE TABLE "profile_changes" (
	"user_id" text PRIMARY KEY NOT NULL,
	"changed_by" text NOT NULL,
	"workspace_id" text NOT NULL,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"previous" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "member_notification_settings" ADD COLUMN "updated_by" text;--> statement-breakpoint
ALTER TABLE "profile_changes" ADD CONSTRAINT "profile_changes_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;