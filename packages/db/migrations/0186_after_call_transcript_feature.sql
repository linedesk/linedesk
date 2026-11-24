-- After-call transcription is a feature, not a provider: it uses the key connected for its service under
-- Providers (speech to text, language model or voice) and its pick is `after_call_transcript`. The old transcription
-- providers' own keys, links, pick, tests and failures go; before go-live, no backfill (CLAUDE.md rule 5).
DELETE FROM "provider_settings"
WHERE "provider" IN ('openai_transcript', 'deepgram_transcript', 'assemblyai', 'elevenlabs_transcript');
--> statement-breakpoint
DELETE FROM "instance_settings"
WHERE "key" = 'active_provider.transcript'
  OR "key" IN (
    'key_from.openai_transcript', 'key_from.deepgram_transcript', 'key_from.assemblyai', 'key_from.elevenlabs_transcript'
  );
--> statement-breakpoint
DELETE FROM "provider_tests"
WHERE "provider" IN ('openai_transcript', 'deepgram_transcript', 'assemblyai', 'elevenlabs_transcript');
--> statement-breakpoint
DELETE FROM "provider_failures"
WHERE "provider" IN ('openai_transcript', 'deepgram_transcript', 'assemblyai', 'elevenlabs_transcript');
