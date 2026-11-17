ALTER TABLE "billing_accounts" ALTER COLUMN "recharge_amount_cents" SET DEFAULT 2500;--> statement-breakpoint
ALTER TABLE "billing_recharges" ADD COLUMN "tax" text;--> statement-breakpoint
ALTER TABLE "billing_recharges" ADD CONSTRAINT "billing_recharges_tax" CHECK ("billing_recharges"."tax" is null or "billing_recharges"."tax" in ('on', 'off', 'no_address'));