CREATE TABLE "feedback" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"actor_id" text NOT NULL,
	"via" text NOT NULL,
	"client" text,
	"kind" text NOT NULL,
	"text" text NOT NULL,
	"page" text,
	"context" jsonb,
	"has_screenshot" boolean DEFAULT false NOT NULL,
	"contact_email" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"last_error" text,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "feedback_kind" CHECK ("feedback"."kind" in ('bug', 'feature', 'setup')),
	CONSTRAINT "feedback_via" CHECK ("feedback"."via" in ('app', 'api_key', 'personal_key', 'mcp_oauth', 'setup_link')),
	CONSTRAINT "feedback_status" CHECK ("feedback"."status" in ('pending', 'sent', 'kept', 'failed'))
);
--> statement-breakpoint
CREATE INDEX "feedback_actor_created" ON "feedback" USING btree ("actor_id","created_at");--> statement-breakpoint
CREATE INDEX "feedback_ws" ON "feedback" USING btree ("workspace_id");