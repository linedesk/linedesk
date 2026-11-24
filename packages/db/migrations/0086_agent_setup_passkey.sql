ALTER TABLE "agent_setup_keys" ADD COLUMN "passkey_confirmed_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "commands" ADD COLUMN "setup_key_id" text;