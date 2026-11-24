ALTER TABLE "assistants" ALTER COLUMN "email_rules" SET DEFAULT '{"rules":[]}'::jsonb;--> statement-breakpoint
-- LIN-768: who gets every call email is each member's own setting now; the assistant's `always` list goes, in one step before go-live.
UPDATE "assistants" SET "email_rules" = "email_rules" - 'always' WHERE "email_rules" ? 'always';
