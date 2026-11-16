CREATE TABLE "billing_refunds" (
	"id" text PRIMARY KEY NOT NULL,
	"billing_account_id" text NOT NULL,
	"request_id" text NOT NULL,
	"payment_entry_id" text NOT NULL,
	"stripe_invoice_id" text NOT NULL,
	"stripe_line_id" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"period_id" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"credit_note_id" text,
	"refunded_cents" integer,
	"ledger_entry_id" text,
	"actor_id" text,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "billing_refunds_request_id_unique" UNIQUE("request_id"),
	CONSTRAINT "billing_refunds_status" CHECK ("billing_refunds"."status" in ('pending', 'posted', 'void')),
	CONSTRAINT "billing_refunds_amount" CHECK ("billing_refunds"."amount_cents" > 0),
	CONSTRAINT "billing_refunds_resolved" CHECK (("billing_refunds"."status" = 'pending') = ("billing_refunds"."resolved_at" is null))
);
--> statement-breakpoint
ALTER TABLE "billing_accounts" ADD COLUMN "suspend_reason" text;--> statement-breakpoint
ALTER TABLE "billing_accounts" ADD COLUMN "suspended_from" text;--> statement-breakpoint
ALTER TABLE "billing_accounts" ADD COLUMN "concurrent_calls_cap" integer;--> statement-breakpoint
ALTER TABLE "billing_refunds" ADD CONSTRAINT "billing_refunds_billing_account_id_billing_accounts_id_fk" FOREIGN KEY ("billing_account_id") REFERENCES "public"."billing_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_refunds" ADD CONSTRAINT "billing_refunds_period_id_billing_periods_id_fk" FOREIGN KEY ("period_id") REFERENCES "public"."billing_periods"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "billing_refunds_bill_status" ON "billing_refunds" USING btree ("billing_account_id","status");--> statement-breakpoint
ALTER TABLE "billing_accounts" ADD CONSTRAINT "billing_accounts_suspend_reason" CHECK ("billing_accounts"."suspend_reason" is null or "billing_accounts"."suspend_reason" in ('admin', 'payment', 'dispute', 'early_fraud_warning'));--> statement-breakpoint
-- A bill suspended before suspend_reason existed was suspended by dunning (security review of #919, L1).
UPDATE "billing_accounts" SET "suspend_reason" = 'payment' WHERE "status" = 'suspended' AND "suspend_reason" IS NULL;--> statement-breakpoint
ALTER TABLE "billing_accounts" ADD CONSTRAINT "billing_accounts_suspended_reason" CHECK ("billing_accounts"."status" <> 'suspended' or "billing_accounts"."suspend_reason" is not null);--> statement-breakpoint
ALTER TABLE "billing_accounts" ADD CONSTRAINT "billing_accounts_suspended_from" CHECK ("billing_accounts"."suspended_from" is null or "billing_accounts"."suspended_from" in ('pending_payment', 'trialing', 'active', 'past_due', 'comped'));--> statement-breakpoint
ALTER TABLE "billing_accounts" ADD CONSTRAINT "billing_accounts_concurrent_calls_cap" CHECK ("billing_accounts"."concurrent_calls_cap" is null or "billing_accounts"."concurrent_calls_cap" between 1 and 1000);