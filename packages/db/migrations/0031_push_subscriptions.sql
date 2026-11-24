CREATE TABLE "push_subscriptions" (
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"endpoint" text NOT NULL,
	"p256dh" text NOT NULL,
	"auth" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "push_subscriptions_workspace_id_endpoint_pk" PRIMARY KEY("workspace_id","endpoint")
);
--> statement-breakpoint
ALTER TABLE "member_notification_settings" ADD COLUMN "push_summary" boolean;--> statement-breakpoint
CREATE INDEX "push_subscriptions_user_idx" ON "push_subscriptions" USING btree ("user_id");