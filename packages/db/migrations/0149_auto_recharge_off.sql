ALTER TABLE "billing_accounts" ALTER COLUMN "auto_recharge" SET DEFAULT false;--> statement-breakpoint
UPDATE "billing_accounts" SET "auto_recharge" = false WHERE "status" = 'pending_payment';
