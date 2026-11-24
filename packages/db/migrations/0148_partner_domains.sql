CREATE TABLE "partner_domains" (
	"id" text PRIMARY KEY NOT NULL,
	"partner_id" text NOT NULL,
	"hostname" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"challenge_token" text NOT NULL,
	"provider_id" text,
	"provider_records" jsonb,
	"provider_status" jsonb,
	"last_checked_at" timestamp with time zone,
	"checks_until" timestamp with time zone,
	"active_at" timestamp with time zone,
	"failed_at" timestamp with time zone,
	"failure" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	"removed_at" timestamp with time zone,
	"removed_by" text,
	"removed_reason" text,
	CONSTRAINT "partner_domains_status" CHECK ("partner_domains"."status" in ('pending', 'verifying', 'active', 'failed', 'stopped', 'removed')),
	CONSTRAINT "partner_domains_failure" CHECK ("partner_domains"."failure" is null or "partner_domains"."failure" in ('cname_missing', 'txt_missing', 'cert_failed', 'moved', 'probe_failed')),
	CONSTRAINT "partner_domains_hostname" CHECK ("partner_domains"."hostname" ~ '^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$'),
	CONSTRAINT "partner_domains_removed" CHECK (("partner_domains"."status" = 'removed') = ("partner_domains"."removed_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "partner_domains" ADD CONSTRAINT "partner_domains_partner_id_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."partners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "partner_domains_hostname" ON "partner_domains" USING btree ("hostname") WHERE "partner_domains"."status" <> 'removed';--> statement-breakpoint
CREATE UNIQUE INDEX "partner_domains_one_per_partner" ON "partner_domains" USING btree ("partner_id") WHERE "partner_domains"."status" <> 'removed';--> statement-breakpoint
-- The host check turns on with the first partner address and stays on (apps/api/src/request-host.ts HOST_CHECK_KEY;
-- security review of #1172, L-2): rows that go later (a partner deleted, its rows cascading) never switch it off.
CREATE OR REPLACE FUNCTION partner_domains_latch_host_check() RETURNS trigger AS $$
BEGIN
  INSERT INTO instance_settings (key, value, updated_by) VALUES ('partnerDomains.hostCheck', 'on', 'partner_domains')
  ON CONFLICT (key) DO NOTHING;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER partner_domains_latch_host_check AFTER INSERT ON partner_domains
  FOR EACH ROW EXECUTE FUNCTION partner_domains_latch_host_check();
