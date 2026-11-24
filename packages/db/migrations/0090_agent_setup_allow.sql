ALTER TABLE "agent_setup_keys" ADD COLUMN "allow_request" jsonb;--> statement-breakpoint
ALTER TABLE "session" ADD COLUMN "passkey_grant_used_at" timestamp;