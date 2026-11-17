CREATE TABLE "partner_branding" (
	"partner_id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"color" text,
	"logo" text,
	"logo_version" text,
	"support_email" text,
	"terms_url" text,
	"privacy_url" text,
	"revision" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	"approved_revision" integer,
	"approved_name" text,
	"approved_logo" text,
	"approved_logo_version" text,
	"approved_support_email" text,
	"approved_terms_url" text,
	"approved_privacy_url" text,
	"approved_at" timestamp with time zone,
	"approved_by" text,
	CONSTRAINT "partner_branding_color" CHECK ("partner_branding"."color" is null or "partner_branding"."color" ~ '^#[0-9a-f]{6}$'),
	CONSTRAINT "partner_branding_approved" CHECK (("partner_branding"."approved_revision" is null) = ("partner_branding"."approved_name" is null) and ("partner_branding"."approved_revision" is null) = ("partner_branding"."approved_at" is null))
);
--> statement-breakpoint
ALTER TABLE "partner_branding" ADD CONSTRAINT "partner_branding_partner_id_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."partners"("id") ON DELETE cascade ON UPDATE no action;