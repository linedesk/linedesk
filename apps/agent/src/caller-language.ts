// The voice follows the language the caller speaks, when the assistant may speak it (assistants.languages):
// it starts in the main language and switches to another allowed one (and back). The language model switches by
// its instructions (prompt.ts languageInstructions); the voice provider has to be told too: Cartesia reads every
// text as English unless told otherwise, ElevenLabs normalizes numbers and dates by the language it is given.
// The fixed lines said during the call (still there?, goodbye, quick tool replies) use the language spoken now.
import type { Language } from '@linedesk/actions'
import { voice } from '@livekit/agents'
import type { CallLanguages } from './pipeline.ts'

/** A voice whose language can change mid-call (both ElevenLabs' and Cartesia's TTS). */
export type LanguageVoice = { updateOptions(opts: { language?: string }): void }

/** Shorter turns ("okay", "yes") are often detected as the wrong language, so they never switch the voice. */
const MIN_WORDS_TO_SWITCH = 3

/** The language to speak after a caller's turn, or null to stay: an allowed language, else the main one. */
export function nextLanguage(
  current: Language,
  detected: string | null,
  transcript: string,
  { main, others }: CallLanguages,
): Language | null {
  if (!detected || transcript.trim().split(/\s+/).length < MIN_WORDS_TO_SWITCH) return null
  const base = detected.toLowerCase().split('-')[0]
  const target = others.find(code => code === base) ?? main
  return target === current ? null : target
}

/** Switches the call's voice to each allowed language the caller speaks; returns the language spoken now. */
export function followCallerLanguage(
  session: voice.AgentSession,
  tts: LanguageVoice,
  languages: CallLanguages,
  callId: string,
): () => Language {
  let current = languages.main
  if (!languages.others.length) return () => current
  session.on(voice.AgentSessionEventTypes.UserInputTranscribed, ({ isFinal, language, transcript }) => {
    if (!isFinal) return
    const next = nextLanguage(current, language, transcript, languages)
    if (!next) return
    tts.updateOptions({ language: next })
    console.log(`call ${callId}: speaking ${next} (caller's language: ${language})`)
    current = next
  })
  return () => current
}
