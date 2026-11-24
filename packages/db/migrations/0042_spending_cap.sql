CREATE TABLE "spending_cap_alerts" (
	"workspace_id" text NOT NULL,
	"month" text NOT NULL,
	"level" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "spending_cap_alerts_workspace_id_month_level_pk" PRIMARY KEY("workspace_id","month","level")
);
--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "spending_cap_cents" integer;