CREATE TABLE "partner_sender_domains" (
	"id" text PRIMARY KEY NOT NULL,
	"partner_id" text NOT NULL,
	"domain" text NOT NULL,
	"local_part" text DEFAULT 'notify' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"provider" text DEFAULT 'resend' NOT NULL,
	"provider_domain_id" text,
	"records" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"provider_status" text,
	"failed_checks" integer DEFAULT 0 NOT NULL,
	"last_checked_at" timestamp with time zone,
	"checks_until" timestamp with time zone,
	"verified_at" timestamp with time zone,
	"failed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	"removed_at" timestamp with time zone,
	"removed_by" text,
	"removed_reason" text,
	CONSTRAINT "partner_sender_domains_status" CHECK ("partner_sender_domains"."status" in ('pending', 'verified', 'failed', 'stopped', 'removed')),
	CONSTRAINT "partner_sender_domains_domain" CHECK ("partner_sender_domains"."domain" ~ '^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$'),
	CONSTRAINT "partner_sender_domains_local_part" CHECK ("partner_sender_domains"."local_part" ~ '^[a-z0-9][a-z0-9._-]{0,31}$'),
	CONSTRAINT "partner_sender_domains_removed" CHECK (("partner_sender_domains"."status" = 'removed') = ("partner_sender_domains"."removed_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "partner_branding" ADD COLUMN "support_email_verified" text;--> statement-breakpoint
ALTER TABLE "partner_sender_domains" ADD CONSTRAINT "partner_sender_domains_partner_id_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."partners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "partner_sender_domains_domain" ON "partner_sender_domains" USING btree ("domain") WHERE "partner_sender_domains"."status" <> 'removed';--> statement-breakpoint
CREATE UNIQUE INDEX "partner_sender_domains_one_per_partner" ON "partner_sender_domains" USING btree ("partner_id") WHERE "partner_sender_domains"."status" <> 'removed';