-- Billing PR 10/11: the subscription's billing cycle anchor, the
-- first-payment grace, the unpaid and port-out state of numbers, disputes, and the new alert kinds. Expand-only. No
-- founding price set: the founding price was dropped (2026-11-16), so no plan_prices or price_locked_until.
-- Why a bill is suspended is #919's `suspend_reason` (0120: admin, payment, dispute, early_fraud_warning) and its check
-- `billing_accounts_suspended_reason`; this migration adds no reason column or check of its own.
-- Generated with db:generate on top of 0125_mcp_oauth and numbered 0126. Drizzle skips a migration whose journal
-- "when" is older than the last applied one: it must stay the last entry with the latest "when".
-- Idempotent (IF NOT EXISTS / DROP ... IF EXISTS before every ADD CONSTRAINT), so a partly applied run can be retried.
-- It rewrites the billing_alerts kind check with every kind, PR 8's trial_will_end included.
CREATE TABLE IF NOT EXISTS "billing_disputes" (
	"id" text PRIMARY KEY NOT NULL,
	"billing_account_id" text NOT NULL,
	"kind" text NOT NULL,
	"charge_id" text NOT NULL,
	"status" text NOT NULL,
	"credit_entry_id" text,
	"adjustment_entry_id" text,
	"reversal_entry_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_disputes_kind" CHECK ("billing_disputes"."kind" in ('dispute', 'fraud_warning'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "billing_numbers" (
	"phone_number_id" text PRIMARY KEY NOT NULL,
	"billing_account_id" text NOT NULL,
	"unpaid_since" timestamp with time zone,
	"unpaid_period_id" text,
	"port_out_code" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_numbers_unpaid" CHECK (("billing_numbers"."unpaid_since" is null) = ("billing_numbers"."unpaid_period_id" is null))
);
--> statement-breakpoint
ALTER TABLE "billing_alerts" DROP CONSTRAINT IF EXISTS "billing_alerts_kind";--> statement-breakpoint
ALTER TABLE "billing_accounts" ADD COLUMN IF NOT EXISTS "billing_anchor" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "billing_accounts" ADD COLUMN IF NOT EXISTS "past_due_first_payment" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "billing_disputes" DROP CONSTRAINT IF EXISTS "billing_disputes_billing_account_id_billing_accounts_id_fk";--> statement-breakpoint
ALTER TABLE "billing_disputes" ADD CONSTRAINT "billing_disputes_billing_account_id_billing_accounts_id_fk" FOREIGN KEY ("billing_account_id") REFERENCES "public"."billing_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_numbers" DROP CONSTRAINT IF EXISTS "billing_numbers_phone_number_id_phone_numbers_id_fk";--> statement-breakpoint
ALTER TABLE "billing_numbers" ADD CONSTRAINT "billing_numbers_phone_number_id_phone_numbers_id_fk" FOREIGN KEY ("phone_number_id") REFERENCES "public"."phone_numbers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_numbers" DROP CONSTRAINT IF EXISTS "billing_numbers_billing_account_id_billing_accounts_id_fk";--> statement-breakpoint
ALTER TABLE "billing_numbers" ADD CONSTRAINT "billing_numbers_billing_account_id_billing_accounts_id_fk" FOREIGN KEY ("billing_account_id") REFERENCES "public"."billing_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_numbers" DROP CONSTRAINT IF EXISTS "billing_numbers_unpaid_period_id_billing_periods_id_fk";--> statement-breakpoint
ALTER TABLE "billing_numbers" ADD CONSTRAINT "billing_numbers_unpaid_period_id_billing_periods_id_fk" FOREIGN KEY ("unpaid_period_id") REFERENCES "public"."billing_periods"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "billing_disputes_bill" ON "billing_disputes" USING btree ("billing_account_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "billing_disputes_charge" ON "billing_disputes" USING btree ("charge_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "billing_numbers_bill" ON "billing_numbers" USING btree ("billing_account_id");--> statement-breakpoint
ALTER TABLE "billing_alerts" ADD CONSTRAINT "billing_alerts_kind" CHECK ("billing_alerts"."kind" in ('recharge_failed', 'recharge_cap_reached', 'low_balance', 'renewal_reminder', 'trial_will_end', 'number_unpaid', 'dunning', 'numbers_release', 'numbers_released'));
