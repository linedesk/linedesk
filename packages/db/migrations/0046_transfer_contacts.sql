ALTER TABLE "assistants" ADD COLUMN "transfers" jsonb DEFAULT '[{"id":"person","name":"Owner","number":null,"condition":"The caller asks to speak to a person","hours_only":true,"ring_seconds":25,"if_no_answer":"message","enabled":true}]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN "transfer_name" text;--> statement-breakpoint
-- The single on-call number becomes the first transfer contact (urgent calls), before the default one.
UPDATE "assistants" SET "transfers" = jsonb_build_array(jsonb_build_object(
  'id', 'oncall',
  'name', 'On-call',
  'number', "transfer_number",
  'condition', 'Urgent: an emergency that needs a person right now',
  'hours_only', "transfer_hours_only",
  'ring_seconds', 25,
  'if_no_answer', 'message_urgent',
  'enabled', "transfer_urgent"
)) || "transfers"
WHERE "transfer_number" IS NOT NULL;
