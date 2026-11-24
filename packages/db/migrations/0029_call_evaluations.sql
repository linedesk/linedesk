CREATE TABLE "call_evaluations" (
	"call_id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"score" integer NOT NULL,
	"issues" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"model" text,
	"assistant_version" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "call_evaluations" ADD CONSTRAINT "call_evaluations_call_id_calls_id_fk" FOREIGN KEY ("call_id") REFERENCES "public"."calls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "call_evaluations_ws_score" ON "call_evaluations" USING btree ("workspace_id","score");