CREATE TABLE "reply_timings" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"call_id" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"pipeline" text NOT NULL,
	"providers" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"turn_ms" integer,
	"model_ms" integer,
	"voice_ms" integer,
	"server_ms" integer,
	"total_ms" integer,
	"heard_ms" integer
);
--> statement-breakpoint
ALTER TABLE "reply_timings" ADD CONSTRAINT "reply_timings_call_id_calls_id_fk" FOREIGN KEY ("call_id") REFERENCES "public"."calls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "reply_timings_at" ON "reply_timings" USING btree ("at");