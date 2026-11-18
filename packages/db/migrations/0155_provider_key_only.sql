-- A provider holds only its key (decisions.md 2026-11-18): the models come from the call quality levels (Server admin ›
-- Providers › Call quality), the voice from each assistant. The stored model, voice and summary model fields of the
-- speech recognition, language model, voice and realtime providers go; the levels already cover what they chose.
DELETE FROM "provider_settings"
WHERE "workspace_id" IS NULL
  AND "field" IN ('model', 'summary_model', 'voice_id', 'voice')
  AND "provider" IN (
    'deepgram', 'elevenlabs_stt', 'openai_stt', 'assemblyai_stt',
    'openai', 'openrouter', 'anthropic', 'gemini', 'groq', 'mistral',
    'elevenlabs', 'cartesia', 'openai_realtime'
  );
