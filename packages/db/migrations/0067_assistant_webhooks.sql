ALTER TABLE "webhook_endpoints" ALTER COLUMN "events" SET DEFAULT '[]'::jsonb;--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN "caller_details" jsonb;--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ADD COLUMN "assistant_id" text;--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ADD COLUMN "hooks" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_assistant_id_assistants_id_fk" FOREIGN KEY ("assistant_id") REFERENCES "public"."assistants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_endpoints_assistant" ON "webhook_endpoints" USING btree ("assistant_id");--> statement-breakpoint
-- Webhooks are per assistant now. An endpoint that got finished calls keeps getting them: the oldest such
-- endpoint of a workspace becomes the webhook of the workspace's first assistant, with the after-call hook on.
-- Any other endpoint (only bookings or messages, or a second one) gets nothing any more and is shown nowhere.
UPDATE "webhook_endpoints" AS e SET "assistant_id" = picked."assistant_id", "hooks" = '["call_end"]'::jsonb
FROM (
  SELECT DISTINCT ON (w."workspace_id") w."id",
    (SELECT a."id" FROM "assistants" a WHERE a."workspace_id" = w."workspace_id" ORDER BY a."created_at", a."id" LIMIT 1) AS "assistant_id"
  FROM "webhook_endpoints" w
  WHERE w."events" ? 'call.completed' OR w."events" ? 'call.summary_ready'
  ORDER BY w."workspace_id", w."created_at", w."id"
) AS picked
WHERE e."id" = picked."id" AND picked."assistant_id" IS NOT NULL;
