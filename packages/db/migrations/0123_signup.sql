-- Billing PR 7 and 8: sign-up attempts for the code and IP limits, the trial_will_end alert
-- kind, and what trial Checkout records on the bill (PR 8: the confirmed Checkout, a refused trial, Radar's risk level,
-- a cancel at the period end).
-- Idempotent (IF NOT EXISTS / IF EXISTS), so it can run before or after #879's billing lifecycle migration on any install.
-- The alert-kind check lists the kinds of both migrations, so whichever runs last keeps every kind valid.
CREATE TABLE IF NOT EXISTS "signup_attempts" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"email_hash" text,
	"ip_bucket" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "signup_attempts_kind" CHECK ("signup_attempts"."kind" in ('code', 'signup'))
);
--> statement-breakpoint
ALTER TABLE "billing_alerts" DROP CONSTRAINT IF EXISTS "billing_alerts_kind";--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "signup_attempts_email" ON "signup_attempts" USING btree ("kind","email_hash","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "signup_attempts_ip" ON "signup_attempts" USING btree ("kind","ip_bucket","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "signup_attempts_created" ON "signup_attempts" USING btree ("created_at");--> statement-breakpoint
ALTER TABLE "billing_alerts" ADD CONSTRAINT "billing_alerts_kind" CHECK ("billing_alerts"."kind" in ('recharge_failed', 'recharge_cap_reached', 'low_balance', 'renewal_reminder', 'trial_will_end', 'number_unpaid', 'dunning', 'numbers_release', 'numbers_released'));--> statement-breakpoint
ALTER TABLE "billing_accounts" ADD COLUMN IF NOT EXISTS "checkout_confirmed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "billing_accounts" ADD COLUMN IF NOT EXISTS "trial_refused" text;--> statement-breakpoint
ALTER TABLE "billing_accounts" ADD COLUMN IF NOT EXISTS "card_risk_level" text;--> statement-breakpoint
ALTER TABLE "billing_accounts" ADD COLUMN IF NOT EXISTS "cancel_at_period_end" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "billing_accounts" DROP CONSTRAINT IF EXISTS "billing_accounts_trial_refused";--> statement-breakpoint
ALTER TABLE "billing_accounts" ADD CONSTRAINT "billing_accounts_trial_refused" CHECK ("billing_accounts"."trial_refused" is null or "billing_accounts"."trial_refused" in ('card_used', 'prepaid'));
