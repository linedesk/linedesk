CREATE TABLE "provider_failures" (
	"provider" text PRIMARY KEY NOT NULL,
	"reason" text NOT NULL,
	"message" text NOT NULL,
	"source" text NOT NULL,
	"since" timestamp with time zone DEFAULT now() NOT NULL,
	"last_at" timestamp with time zone DEFAULT now() NOT NULL,
	"count" integer DEFAULT 1 NOT NULL,
	"workspace_id" text,
	"call_id" text,
	"alerted_at" timestamp with time zone
);
