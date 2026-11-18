-- Call quality (decisions.md 2026-11-18, security review H-1): every assistant on Standard with the level's default
-- models (its own model picks go, its voice stays), and new assistants on Standard. No mapping from earlier model
-- picks or the old pipeline policy (before go-live, no legacy). For installs that ran 0153 as it first was (staging,
-- and production from v0.1.24 on); 0153 itself now does the same. Raising again is up to whoever pays, per assistant.
UPDATE "assistants" SET "call_quality" = 'standard', "llm_model" = NULL, "realtime_model" = NULL, "voice" = "voice" - 'model'
  WHERE "call_quality" <> 'standard' OR "llm_model" IS NOT NULL OR "realtime_model" IS NOT NULL OR "voice" ? 'model';--> statement-breakpoint
-- A row that is no JSON object already reads as the install default, which starts new assistants on Standard.
UPDATE "instance_settings" SET "value" = jsonb_set("value"::jsonb, '{default}', '"standard"')::text
  WHERE "key" = 'call_quality'
    AND CASE WHEN "value" IS JSON OBJECT THEN "value"::jsonb->>'default' IS DISTINCT FROM 'standard' ELSE false END;
