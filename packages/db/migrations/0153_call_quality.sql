ALTER TABLE "assistants" ADD COLUMN "call_quality" text DEFAULT 'standard' NOT NULL;--> statement-breakpoint
ALTER TABLE "assistants" ADD CONSTRAINT "assistants_call_quality" CHECK ("assistants"."call_quality" in ('standard', 'premium', 'ultra'));--> statement-breakpoint
-- Call quality (decisions.md 2026-11-17): Ultra where the assistant answered with a realtime model, Premium where its
-- voice model or language model was on the Premium list (packages/actions/src/usage-level.ts as of this migration),
-- else Standard. voice_pipeline stays, no longer read, for the release before.
UPDATE "assistants" SET "call_quality" = CASE
  WHEN "voice_pipeline" = 'realtime' THEN 'ultra'
  WHEN ("voice"->>'provider' = 'elevenlabs' AND "voice"->>'model' IN ('eleven_multilingual_v2', 'eleven_v3'))
    OR "llm_model" IN ('gpt-5.4', 'openai/gpt-5.4', 'gpt-4.1', 'openai/gpt-4.1', 'gemini-3.8-flash', 'google/gemini-3.8-flash')
    THEN 'premium'
  ELSE 'standard'
END;--> statement-breakpoint
-- Picks that do not belong to the level go back to the server's default for it.
UPDATE "assistants" SET "realtime_model" = NULL WHERE "call_quality" <> 'ultra' AND "realtime_model" IS NOT NULL;--> statement-breakpoint
UPDATE "assistants" SET "llm_model" = NULL, "voice" = "voice" - 'model'
  WHERE "call_quality" = 'ultra' AND ("llm_model" IS NOT NULL OR "voice" ? 'model');--> statement-breakpoint
-- The install's settings (Server admin › Providers › Call quality): Premium and Ultra on (decisions.md 2026-11-17: the
-- Ultra switch is a normal level, it can be picked once a realtime model is connected), new assistants on Ultra where
-- the server admin had every call answered by the realtime model, else on Standard. Models: the defaults until a server
-- admin picks others (CALL_QUALITY_DEFAULTS).
INSERT INTO "instance_settings" ("key", "value")
SELECT 'call_quality', json_build_object(
  'premium', true,
  'ultra', true,
  'default', CASE WHEN (SELECT "value" FROM "instance_settings" WHERE "key" = 'voice_pipeline.policy') = 'realtime' THEN 'ultra' ELSE 'standard' END,
  'models', json_build_object('standard', '{}'::json, 'premium', '{}'::json, 'ultra', '{}'::json)
)::text
ON CONFLICT ("key") DO NOTHING;
