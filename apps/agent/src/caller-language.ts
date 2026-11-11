// The voice follows the language the caller speaks, when the assistant may speak it (assistants.languages).
// The language model switches by its instructions (prompt.ts languageInstructions); the voice provider has to
// be told too: Cartesia reads every text as English unless told otherwise, ElevenLabs normalizes numbers and
// dates by the language it is given.
import type { CallerLanguage } from '@linedesk/actions'
import { voice } from '@livekit/agents'

/** A voice whose language can change mid-call (both ElevenLabs' and Cartesia's TTS). */
export type LanguageVoice = { updateOptions(opts: { language?: string }): void }

/** Shorter turns ("okay", "yes") are often detected as the wrong language, so they never switch the voice. */
const MIN_WORDS_TO_SWITCH = 3

/** The language to speak after a caller's turn, or null to stay: an allowed language, else English. */
export function nextLanguage(
  current: string,
  detected: string | null,
  transcript: string,
  allowed: readonly CallerLanguage[],
): string | null {
  if (!detected || transcript.trim().split(/\s+/).length < MIN_WORDS_TO_SWITCH) return null
  const base = detected.toLowerCase().split('-')[0]!
  const target = (allowed as readonly string[]).includes(base) ? base : 'en'
  return target === current ? null : target
}

/** Switches the call's voice to each allowed language the caller speaks (and back to English). */
export function followCallerLanguage(
  session: voice.AgentSession,
  tts: LanguageVoice,
  allowed: readonly CallerLanguage[],
  callId: string,
) {
  if (!allowed.length) return
  let current = 'en'
  session.on(voice.AgentSessionEventTypes.UserInputTranscribed, ({ isFinal, language, transcript }) => {
    if (!isFinal) return
    const next = nextLanguage(current, language, transcript, allowed)
    if (!next) return
    tts.updateOptions({ language: next })
    console.log(`call ${callId}: speaking ${next} (caller's language: ${language})`)
    current = next
  })
}
