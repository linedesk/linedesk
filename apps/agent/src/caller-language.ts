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

/**
 * Shorter turns ("okay", "yes", "好的", "네") are often detected as the wrong language, so they never switch the voice.
 * Counted in words as the script has them (wordsIn), not by spaces: Chinese and Japanese write a whole sentence
 * without one.
 */
const MIN_WORDS_TO_SWITCH = 3

const wordSegmenter = new Intl.Segmenter(undefined, { granularity: 'word' })

/** How many words a transcript has, in any script (Intl.Segmenter splits Chinese, Japanese and Thai by dictionary). */
export function wordsIn(transcript: string): number {
  let words = 0
  for (const segment of wordSegmenter.segment(transcript)) if (segment.isWordLike) words++
  return words
}

/**
 * The language to speak after a caller's turn, or null to stay: an allowed language (the main one included). A turn
 * detected in a language the call does not allow keeps the current one: it is more often a wrong detection (Nova-3
 * `multi` hears Persian or Arabic in a Mandarin turn) than a caller who changed language, and one wrong turn must not
 * flip the voice back to the main language. Before the caller switched, the current language is the main one.
 */
export function nextLanguage(
  current: Language,
  detected: string | null,
  transcript: string,
  { main, others }: CallLanguages,
): Language | null {
  if (!detected || wordsIn(transcript) < MIN_WORDS_TO_SWITCH) return null
  const base = detected.toLowerCase().split('-')[0]
  const target = base === main ? main : others.find(code => code === base)
  return !target || target === current ? null : target
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
