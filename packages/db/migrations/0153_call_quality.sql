ALTER TABLE "assistants" ADD COLUMN "call_quality" text DEFAULT 'standard' NOT NULL;--> statement-breakpoint
ALTER TABLE "assistants" ADD CONSTRAINT "assistants_call_quality" CHECK ("assistants"."call_quality" in ('standard', 'premium', 'ultra'));--> statement-breakpoint
-- Call quality (decisions.md 2026-11-18, security review H-1): every assistant on Standard with the level's default
-- models (its own model picks go, its voice stays); no mapping from earlier model picks or the pipeline policy (before
-- go-live, no legacy). Installs that ran this file as it first was get the same from 0158. voice_pipeline stays, no
-- longer read, for the release before.
UPDATE "assistants" SET "call_quality" = 'standard', "llm_model" = NULL, "realtime_model" = NULL, "voice" = "voice" - 'model';--> statement-breakpoint
-- The install's settings (Server admin › Providers › Call quality): Premium and Ultra on (decisions.md 2026-11-17: the
-- Ultra switch is a normal level, it can be picked once a realtime model is connected), new assistants on Standard.
-- Models: the defaults until a server admin picks others (CALL_QUALITY_DEFAULTS).
INSERT INTO "instance_settings" ("key", "value")
SELECT 'call_quality', json_build_object(
  'premium', true,
  'ultra', true,
  'default', 'standard',
  'models', json_build_object('standard', '{}'::json, 'premium', '{}'::json, 'ultra', '{}'::json)
)::text
ON CONFLICT ("key") DO NOTHING;
