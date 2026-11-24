CREATE TABLE "voice_clones" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"provider" text NOT NULL,
	"voice_id" text NOT NULL,
	"name" text NOT NULL,
	"consent_by" text NOT NULL,
	"consent_at" timestamp with time zone NOT NULL,
	"consent_text" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "voice_clones_voice" UNIQUE("provider","voice_id")
);
--> statement-breakpoint
CREATE INDEX "voice_clones_ws" ON "voice_clones" USING btree ("workspace_id");