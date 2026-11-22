CREATE TABLE "app_setup_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"provider" text NOT NULL,
	"shop" text NOT NULL,
	"requested_by" text NOT NULL,
	"status" text DEFAULT 'requested' NOT NULL,
	"install_url" text,
	"failure" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "app_setup_requests_open" ON "app_setup_requests" USING btree ("workspace_id","provider") WHERE "app_setup_requests"."status" <> 'connected';--> statement-breakpoint
CREATE INDEX "app_setup_requests_shop" ON "app_setup_requests" USING btree ("shop");