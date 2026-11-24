ALTER TABLE "session" ADD COLUMN "host_domain_id" text;--> statement-breakpoint
-- White-label S5 (apps/api/src/host-sessions.ts; security review of S5.2, L-3): a session made on a partner's address is
-- bound to that address's row, not only its name. Sessions from before carry only the name, which no request fits any
-- more: they go (no partner address is live anywhere yet).
DELETE FROM "session" WHERE "host" IS NOT NULL;--> statement-breakpoint
-- auth-schema.ts cannot import schema.ts, so the foreign key is here: a deleted address (its partner deleted) takes its
-- sessions with it.
ALTER TABLE "session" ADD CONSTRAINT "session_host_domain_id_partner_domains_id_fk" FOREIGN KEY ("host_domain_id") REFERENCES "public"."partner_domains"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "session_host_domain_id_idx" ON "session" USING btree ("host_domain_id") WHERE "host_domain_id" IS NOT NULL;--> statement-breakpoint
-- An address that leaves `active` (failed, stopped, removed) or changes its name ends every session made on it, at
-- once and for good: a re-approval later does not bring them back.
CREATE OR REPLACE FUNCTION partner_domains_end_sessions() RETURNS trigger AS $$
BEGIN
  IF NEW.status <> 'active' OR NEW.hostname <> OLD.hostname THEN
    DELETE FROM "session" WHERE "host_domain_id" = NEW.id;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER partner_domains_end_sessions AFTER UPDATE OF status, hostname ON partner_domains
  FOR EACH ROW EXECUTE FUNCTION partner_domains_end_sessions();--> statement-breakpoint
-- A partner that is no longer approved (suspended) ends every session made on its addresses, for good as well.
CREATE OR REPLACE FUNCTION partners_end_host_sessions() RETURNS trigger AS $$
BEGIN
  IF NEW.status <> 'approved' THEN
    DELETE FROM "session" WHERE "host_domain_id" IN (SELECT id FROM partner_domains WHERE partner_id = NEW.id);
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER partners_end_host_sessions AFTER UPDATE OF status ON partners
  FOR EACH ROW EXECUTE FUNCTION partners_end_host_sessions();
