ALTER TABLE "ledger_entries" DROP CONSTRAINT "ledger_entries_price_basis";--> statement-breakpoint
ALTER TABLE "call_reservations" ADD COLUMN "usage_level" text DEFAULT 'standard' NOT NULL;--> statement-breakpoint
ALTER TABLE "call_reservations" ADD COLUMN "own_keys" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "call_reservations" ADD COLUMN "limit_seconds" integer DEFAULT 3600 NOT NULL;--> statement-breakpoint
ALTER TABLE "call_reservations" ADD COLUMN "included_reserved_seconds" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "call_reservations" ADD CONSTRAINT "call_reservations_usage_level" CHECK ("call_reservations"."usage_level" in ('standard', 'premium', 'ultra'));--> statement-breakpoint
ALTER TABLE "call_reservations" ADD CONSTRAINT "call_reservations_limit" CHECK ("call_reservations"."limit_seconds" > 0);--> statement-breakpoint
ALTER TABLE "call_reservations" ADD CONSTRAINT "call_reservations_included_reserved" CHECK ("call_reservations"."included_reserved_seconds" >= 0);--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_price_basis" CHECK ("ledger_entries"."price_basis" is null or "ledger_entries"."price_basis" in ('standard', 'premium', 'ultra', 'own_keys', 'fixed_5c', 'cost_plus_10'));