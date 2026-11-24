CREATE TABLE "mail_analyses" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"months" integer NOT NULL,
	"conversations_read" integer DEFAULT 0 NOT NULL,
	"conversations_analyzed" integer DEFAULT 0 NOT NULL,
	"topics" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error" text,
	"model" text,
	"requested_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "mail_analyses_ws_created" ON "mail_analyses" USING btree ("workspace_id","created_at");