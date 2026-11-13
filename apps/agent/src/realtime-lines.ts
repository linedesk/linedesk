// The fixed lines of a realtime call (still there?, the closing line, the goodbye, the time limit) are said as written:
// made by OpenAI's speech model in the realtime model's voice (lineVoiceOf) and played as the assistant's speech.
// Asked to say such a line, the model often said something else: a question of its own, even the caller's part (LIN-93).
// While a line plays the model's own replies are off; the line goes into its conversation as its own words, and into the
// call's transcript like any other. When the audio cannot be made in time, the model is asked to say the line, as before.
import type { GreetingAudio } from './greeting-cache.ts'

/** How long a line's audio may take to make (the first time; then it is cached) before the model is asked to say it. */
export const LINE_AUDIO_WAIT_MS = 4000

/** Says a fixed line; resolves once it has played or was cut off. `last`: the call ends after it. */
export type SayFixedLine = (text: string, options?: { allowInterruptions?: boolean; last?: boolean }) => Promise<void>

/** The realtime session, as far as the lines need it: OpenAI events out. */
export type RealtimeControl = { sendEvent(event: object): void }

export type RealtimeLineDeps = {
  /** The line's audio in the realtime voice (lineAudio, cached). */
  audio: (text: string) => Promise<GreetingAudio>
  /** Plays the audio as the assistant's speech with `text` as its words; resolves once played or cut off. */
  play: (text: string, audio: GreetingAudio, allowInterruptions: boolean) => Promise<void>
  /** Today's way: the model is asked to say the line itself. */
  askModel: (text: string) => Promise<void>
  /** The realtime session of the call; null while there is none. */
  model: () => RealtimeControl | null
  /** The session.update that turns the model's replies off (false) or on again (realtimeRepliesEvent). */
  repliesEvent: (on: boolean) => object
  /** How many turns the caller finished so far: one finished while a line played has no reply yet. */
  callerTurns: () => number
  /** Has the model answer the caller now (generateReply). */
  answer: () => void
  waitMs?: number
  log?: (line: string) => void
}

/** The line as the assistant's own words in the model's conversation, so it knows what the caller heard. */
export const lineItemEvent = (text: string) => ({
  type: 'conversation.item.create',
  item: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] },
})

/** The audio, or null when it fails or takes longer than `ms`. */
async function audioWithin(audio: Promise<GreetingAudio>, ms: number): Promise<GreetingAudio | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<null>(resolve => {
    timer = setTimeout(() => resolve(null), ms)
  })
  try {
    return await Promise.race([audio, late])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * The fixed-line speaker of a realtime call. While a line plays the model's replies are off; afterwards they are on
 * again (not after a `last` line: the call ends), and a turn the caller finished meanwhile gets its answer then.
 */
export function realtimeLineSpeaker(deps: RealtimeLineDeps): SayFixedLine {
  const { waitMs = LINE_AUDIO_WAIT_MS, log = console.warn } = deps
  return async (text, { allowInterruptions = true, last = false } = {}) => {
    const audio = await audioWithin(deps.audio(text), waitMs).catch(e => {
      log(`fixed line not made, the realtime model says it: ${e instanceof Error ? e.message : String(e)}`)
      return null
    })
    const model = deps.model()
    if (!audio || !model) return deps.askModel(text)
    model.sendEvent(deps.repliesEvent(false))
    const turnsBefore = deps.callerTurns()
    try {
      await deps.play(text, audio, allowInterruptions)
    } finally {
      model.sendEvent(lineItemEvent(text))
      if (!last) {
        model.sendEvent(deps.repliesEvent(true))
        if (deps.callerTurns() !== turnsBefore) deps.answer()
      }
    }
  }
}
