CREATE TABLE "usage_limit_alerts" (
	"workspace_id" text NOT NULL,
	"period_id" text NOT NULL,
	"level" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "usage_limit_alerts_workspace_id_period_id_level_pk" PRIMARY KEY("workspace_id","period_id","level")
);
--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "usage_limit_cents" integer;--> statement-breakpoint
ALTER TABLE "organization" ADD CONSTRAINT "organization_usage_limit" CHECK ("organization"."usage_limit_cents" is null or "organization"."usage_limit_cents" between 100 and 10000000);