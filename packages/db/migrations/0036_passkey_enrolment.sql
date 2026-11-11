ALTER TABLE "user" ADD COLUMN "passkey_enrolment_hash" text;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "passkey_enrolment_expires_at" timestamp;