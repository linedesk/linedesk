-- LIN-769: email_rules replaced these in LIN-470 and nothing reads them; dropped in one step before go-live (no backfill).
ALTER TABLE "assistants" DROP COLUMN "email_routing";--> statement-breakpoint
ALTER TABLE "assistants" DROP COLUMN "email_assign";
