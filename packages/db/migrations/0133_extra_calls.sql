ALTER TABLE "billing_accounts" ADD COLUMN "extra_calls_paid" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "billing_accounts" ADD COLUMN "extra_calls_paid_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "extra_calls" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "billing_accounts" ADD CONSTRAINT "billing_accounts_extra_calls_paid" CHECK ("billing_accounts"."extra_calls_paid" >= 0);--> statement-breakpoint
ALTER TABLE "organization" ADD CONSTRAINT "organization_extra_calls" CHECK ("organization"."extra_calls" between 0 and 1000 and "organization"."extra_calls" % 5 = 0);