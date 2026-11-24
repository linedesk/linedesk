CREATE TABLE "assistant_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"assistant_id" text NOT NULL,
	"number" integer NOT NULL,
	"settings" jsonb NOT NULL,
	"summary" text NOT NULL,
	"changed_by" text,
	"restored_from" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "assistant_versions_number" UNIQUE("assistant_id","number")
);
--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN "assistant_version" integer;--> statement-breakpoint
ALTER TABLE "assistant_versions" ADD CONSTRAINT "assistant_versions_assistant_id_assistants_id_fk" FOREIGN KEY ("assistant_id") REFERENCES "public"."assistants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "assistant_versions_ws" ON "assistant_versions" USING btree ("workspace_id");