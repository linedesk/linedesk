ALTER TABLE "terms_acceptances" DROP CONSTRAINT IF EXISTS "terms_acceptances_source";--> statement-breakpoint
ALTER TABLE "terms_acceptances" ADD COLUMN IF NOT EXISTS "disclosure" jsonb;--> statement-breakpoint
ALTER TABLE "terms_acceptances" ADD CONSTRAINT "terms_acceptances_source" CHECK ("terms_acceptances"."source" in ('signup', 'activation'));--> statement-breakpoint
ALTER TABLE "billing_alerts" DROP CONSTRAINT IF EXISTS "billing_alerts_kind";--> statement-breakpoint
ALTER TABLE "billing_alerts" ADD CONSTRAINT "billing_alerts_kind" CHECK ("billing_alerts"."kind" in ('recharge_failed', 'recharge_cap_reached', 'low_balance', 'renewal_reminder', 'trial_will_end', 'number_unpaid', 'dunning', 'numbers_release', 'numbers_released', 'activation_nudge'));
