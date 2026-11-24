CREATE TABLE "auth_events" (
	"id" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"user_id" text,
	"email" text,
	"event" text NOT NULL,
	"method" text,
	"workspace_id" text,
	"ip_address" text,
	"user_agent" text
);
--> statement-breakpoint
CREATE INDEX "auth_events_created" ON "auth_events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "auth_events_user" ON "auth_events" USING btree ("user_id","created_at");--> statement-breakpoint
-- A deleted user's audit entries stay, without the email, address and browser (docs/architecture.md §12, Audit log).
-- A trigger, so every way a user is deleted (Better Auth, the admin area, SQL) does it.
CREATE OR REPLACE FUNCTION anonymise_auth_events() RETURNS trigger AS $$
BEGIN
  UPDATE auth_events SET email = 'deleted', ip_address = NULL, user_agent = NULL WHERE user_id = OLD.id;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER user_deleted_anonymise_auth_events AFTER DELETE ON "user"
  FOR EACH ROW EXECUTE FUNCTION anonymise_auth_events();
