ALTER TABLE "calls" ADD COLUMN "caller_attestation" text;--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN "spam_likely" boolean DEFAULT false NOT NULL;