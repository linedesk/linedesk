// One mechanism for every stage of the voice pipeline: whatever fails (speech to text, language model, voice, realtime
// model), and however it fails (an error, or an answer with nothing usable in it), becomes one VoiceFailure
// (@linedesk/actions), logged once and handed to `report` (the worker marks the call and tells a test call's browser).
import {
  isPerCallProviderError,
  type ProviderName,
  type VoiceFailure,
  type VoiceStage,
  voiceFailureReason,
  voiceStageName,
} from '@linedesk/actions'
import { APIConnectionError, APIStatusError, APITimeoutError, voice } from '@livekit/agents'

const MAX_MESSAGE = 300

/** The session's error types (AgentSession `error` event) by stage. */
const stageOfError: Record<string, VoiceStage> = {
  stt_error: 'stt',
  llm_error: 'llm',
  tts_error: 'tts',
  realtime_model_error: 'realtime',
}

/** What the provider said, in one line: the error's message and its body, with every secret taken out. */
function errorText(error: unknown, secrets: string[]): string {
  const message = error instanceof Error ? error.message : String(error)
  const body =
    error instanceof APIStatusError || (error && typeof error === 'object' && 'body' in error)
      ? (error as { body?: unknown }).body
      : null
  const text = [message, body ? (typeof body === 'string' ? body : JSON.stringify(body)) : '']
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
  return secrets
    .filter(s => s.length >= 6)
    .reduce((t, s) => t.replaceAll(s, '[redacted]'), text)
    .slice(0, MAX_MESSAGE)
}

/** One VoiceFailure from what a provider threw: the reason from its status and text. */
export function voiceFailureOf(
  stage: VoiceStage,
  provider: ProviderName,
  error: unknown,
  secrets: string[] = [],
): VoiceFailure {
  const status = error instanceof APIStatusError ? error.statusCode : null
  const message = errorText(error, secrets)
  const said = voiceFailureReason({ status, text: message })
  // A timeout says so; a connection that failed without saying why: the provider is not reachable.
  const reason =
    error instanceof APITimeoutError
      ? 'timeout'
      : said === 'unknown' && error instanceof APIConnectionError
        ? 'network'
        : said
  return { stage, provider, reason, message }
}

/**
 * `report` with each stage's first failure only (a used-up quota fails every line of the call): logged once, in one
 * line that names the stage, the provider and why.
 */
export function onceEachStage(report: (failure: VoiceFailure) => void, log: (line: string) => void = console.error) {
  const seen = new Set<string>()
  return (failure: VoiceFailure) => {
    const key = `${failure.stage}:${failure.provider}`
    if (seen.has(key)) return
    seen.add(key)
    log(`${voiceStageName(failure.stage)} ${failure.provider} failed (${failure.reason}): ${failure.message}`)
    report(failure)
  }
}

type SessionEvents = Pick<voice.AgentSession, 'on'>

/**
 * Watches a call's session for failures of any stage: the errors the session reports for speech to text, the language
 * model, the voice (a voice that gives no audio is one: VoiceWithBackup, pipeline.ts) and the realtime model; a reply
 * of the language model with nothing in it (no text, no tool call); and turns that only called tools that do not exist
 * or with arguments that do not fit. `providers`: the provider id of each stage in use.
 */
export function watchVoicePipeline(
  session: SessionEvents,
  providers: Partial<Record<VoiceStage, ProviderName>>,
  report: (failure: VoiceFailure) => void,
  secrets: string[] = [],
  /** A race in the call's own conversation (two replies at once): ours, not the provider failing; counted, not reported. */
  onCallError: (failure: VoiceFailure) => void = () => {},
) {
  session.on(voice.AgentSessionEventTypes.Error, ev => {
    const stage = stageOfError[ev.error.type]
    const provider = stage && providers[stage]
    if (!stage || !provider) return
    const cause = 'error' in ev.error ? ev.error.error : ev.error
    const failure = voiceFailureOf(stage, provider, cause, secrets)
    if (isPerCallProviderError(failure.message)) onCallError(failure)
    else report(failure)
  })
  session.on(voice.AgentSessionEventTypes.MetricsCollected, ({ metrics }) => {
    if (metrics.type !== 'llm_metrics' || metrics.cancelled || metrics.ttftMs >= 0 || !providers.llm) return
    report({
      stage: 'llm',
      provider: providers.llm,
      reason: 'no_output',
      message: 'The reply was empty: no text and no tool call.',
    })
  })
  session.on(voice.AgentSessionEventTypes.FunctionToolsExecuted, ({ functionCallOutputs }) => {
    const unusable = (output: string) => /^(Unknown function|Invalid arguments for)/.test(output)
    if (
      !providers.llm ||
      !functionCallOutputs.length ||
      !functionCallOutputs.every(o => o.isError && unusable(o.output))
    )
      return
    report({
      stage: 'llm',
      provider: providers.llm,
      reason: 'no_output',
      message: `Only unusable tool calls: ${functionCallOutputs.map(o => o.output).join('; ')}`.slice(0, MAX_MESSAGE),
    })
  })
}
