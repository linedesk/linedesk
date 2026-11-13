// When a stage of the voice pipeline fails on a call: speech to text, the language model, the voice or the realtime
// model. The voice agent turns every failure into one VoiceFailure (apps/agent/src/voice-failures.ts), logs it once,
// reports it for the call (call.reportVoiceFailure: the call keeps it in `calls.voice_failures`) and sets it on itself
// (VOICE_FAILURE_ATTRIBUTE), where a test call's browser shows it at once. Shaped like LIN-111's provider failure event
// (ProviderFailureEvent: stage, provider, reason, message) with its reasons; the API also records it as that
// provider's failure (provider_failures), so Admin › Providers and the call show the same problem.
import { z } from 'zod'
import { providerNames, providers } from './admin.ts'
import { defineAction } from './define.ts'
import {
  type ProviderFailureReason,
  providerFailureReason,
  providerFailureReasons,
  providerFailureText,
} from './provider-health.ts'

export const VOICE_STAGES = ['stt', 'llm', 'tts', 'realtime'] as const
export type VoiceStage = (typeof VOICE_STAGES)[number]

/** Why it failed: the shared provider failure reasons (provider-health.ts, LIN-111). */
export const VOICE_FAILURE_REASONS = providerFailureReasons
export type VoiceFailureReason = ProviderFailureReason
/** The longest operator line a failure keeps. */
export const VOICE_FAILURE_MESSAGE_MAX = 300

export const voiceFailureSchema = z.object({
  stage: z.enum(VOICE_STAGES),
  /** The provider's id in the registry (admin.ts: `elevenlabs`, `deepgram`, ...). */
  provider: z.enum(providerNames),
  reason: z.enum(VOICE_FAILURE_REASONS),
  /** One line for the operator: what the provider said, without keys. */
  message: z.string().max(VOICE_FAILURE_MESSAGE_MAX),
})
export type VoiceFailure = z.infer<typeof voiceFailureSchema>

/** At most this many failures are kept per call: one per stage, provider and reason. */
export const VOICE_FAILURES_PER_CALL = 8

/** Attribute the voice agent sets on itself with the last failure, as JSON: the test call shows it while it runs. */
export const VOICE_FAILURE_ATTRIBUTE = 'linedesk.voiceFailure'

/** The failure in VOICE_FAILURE_ATTRIBUTE; null when absent or not one. */
export function parseVoiceFailure(value: string | undefined | null): VoiceFailure | null {
  if (!value) return null
  try {
    const parsed = voiceFailureSchema.safeParse(JSON.parse(value))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

/** The reason from a provider's HTTP status and error text: the shared classifier (provider-health.ts). */
export const voiceFailureReason = providerFailureReason

export const voiceStageNames: Record<VoiceStage, string> = {
  stt: 'speech to text',
  llm: 'language model',
  tts: 'voice',
  realtime: 'realtime model',
}

/** The provider's name as the admin area shows it; its id when it is not in the registry. */
export const voiceProviderLabel = (provider: string) =>
  (providers as Record<string, { label: string } | undefined>)[provider]?.label ?? provider

/**
 * The failure in words. `operator` (an instance admin): which stage and provider, why, and where to fix it. Everyone
 * else: which part of the assistant is not working, and who can fix it; no provider, no internals.
 */
export function voiceFailureText(failure: VoiceFailure, operator: boolean): string {
  const stage = voiceStageNames[failure.stage]
  if (!operator) return `The assistant's ${stage} isn't working right now. Ask whoever runs this server.`
  // The same words as Admin › Providers and the failure email (providerFailureText): one wording per reason.
  return `The assistant's ${stage}: ${providerFailureText(failure.reason, voiceProviderLabel(failure.provider), 'admin')}`
}

export const callReportVoiceFailure = defineAction({
  name: 'call.reportVoiceFailure',
  description:
    'Report that a stage of the voice pipeline (speech to text, language model, voice, realtime model) failed on a call.',
  input: z.object({ callId: z.string().min(1), failure: voiceFailureSchema }),
  permission: 'agent',
  logged: 'ids',
})

/** `data` of call.reportVoiceFailure: the failure as the call keeps it, its reason refined by the provider's own test. */
export type ReportVoiceFailureData = { failure: VoiceFailure }
