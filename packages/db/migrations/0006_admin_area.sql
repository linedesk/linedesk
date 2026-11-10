CREATE TABLE "instance_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text
);
--> statement-breakpoint
CREATE TABLE "provider_settings" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text,
	"provider" text NOT NULL,
	"field" text NOT NULL,
	"value_encrypted" text NOT NULL,
	"last4" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text,
	CONSTRAINT "provider_settings_slot" UNIQUE NULLS NOT DISTINCT("workspace_id","provider","field")
);
--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "disabled_at" timestamp;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "instance_admin" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "disabled_at" timestamp;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "last_sign_in_at" timestamp;--> statement-breakpoint
-- An install that already has users: its first user becomes the instance admin.
UPDATE "user" SET "instance_admin" = true WHERE "id" = (SELECT "id" FROM "user" ORDER BY "created_at", "id" LIMIT 1);
