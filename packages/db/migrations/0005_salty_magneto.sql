ALTER TABLE "assistants" ALTER COLUMN "voice" SET DEFAULT '{"provider":"elevenlabs","voice_id":""}'::jsonb;--> statement-breakpoint
-- Assistants that never chose a voice still hold the old default; move them to the new one.
-- A voice somebody picked (any voice_id, or another provider) is left as it is.
UPDATE "assistants" SET "voice" = '{"provider":"elevenlabs","voice_id":""}'::jsonb WHERE "voice" = '{"provider":"cartesia","voice_id":""}'::jsonb;
