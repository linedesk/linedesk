CREATE TABLE "agent_setup_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"prefix" text NOT NULL,
	"key_hash" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "agent_setup_keys_key_hash_unique" UNIQUE("key_hash")
);
--> statement-breakpoint
CREATE INDEX "agent_setup_keys_creator" ON "agent_setup_keys" USING btree ("created_by");