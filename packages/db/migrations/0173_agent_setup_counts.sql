CREATE TABLE "agent_setup_counts" (
	"day" date NOT NULL,
	"kind" text NOT NULL,
	"client" text NOT NULL,
	"made" integer DEFAULT 0 NOT NULL,
	"connected" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "agent_setup_counts_day_kind_client_pk" PRIMARY KEY("day","kind","client")
);
--> statement-breakpoint
ALTER TABLE "agent_setup_keys" ADD COLUMN "connected_at" timestamp with time zone;