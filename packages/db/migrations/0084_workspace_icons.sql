CREATE TABLE "workspace_icons" (
	"workspace_id" text PRIMARY KEY NOT NULL,
	"png" text NOT NULL,
	"version" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text
);
