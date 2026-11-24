DROP TABLE "knowledge_chunks" CASCADE;--> statement-breakpoint
DROP TABLE "knowledge_documents" CASCADE;--> statement-breakpoint
ALTER TABLE "agent_setup_keys" DROP COLUMN "allow_request";--> statement-breakpoint
ALTER TABLE "assistants" DROP COLUMN "disclose_ai";--> statement-breakpoint
ALTER TABLE "session" DROP COLUMN "passkey_grant_used_at";