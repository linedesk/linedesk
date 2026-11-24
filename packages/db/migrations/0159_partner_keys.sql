CREATE TABLE "partner_providers" (
	"partner_id" text NOT NULL,
	"category" text NOT NULL,
	"provider" text NOT NULL,
	"key_encrypted" text NOT NULL,
	"last4" text,
	"status" text DEFAULT 'untested' NOT NULL,
	"failure" text,
	"checked_at" timestamp with time zone,
	"failure_emailed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text,
	CONSTRAINT "partner_providers_partner_id_category_pk" PRIMARY KEY("partner_id","category"),
	CONSTRAINT "partner_providers_category" CHECK ("partner_providers"."category" in ('stt', 'llm', 'tts', 'realtime')),
	CONSTRAINT "partner_providers_status" CHECK ("partner_providers"."status" in ('untested', 'ok', 'failing'))
);
--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN "partner_keys" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN "key_sources" jsonb;--> statement-breakpoint
ALTER TABLE "partners" ADD COLUMN "own_keys_disabled_reason" text;--> statement-breakpoint
ALTER TABLE "partners" ADD COLUMN "own_keys_disabled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workspace_settings" ADD COLUMN "partner_keys" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "partner_providers" ADD CONSTRAINT "partner_providers_partner_id_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."partners"("id") ON DELETE cascade ON UPDATE no action;