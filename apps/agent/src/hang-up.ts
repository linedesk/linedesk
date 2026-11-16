// How the assistant ends a call: always after saying something, never in the middle of it. After its own goodbye
// (end_call), after the closing line when the line stays silent, and after the goodbye at its time limit.
import {
  SILENCE_FIRST_GAP_DEFAULT_S,
  SILENCE_HANG_UP_DEFAULT_S,
  SILENCE_REMINDERS_DEFAULT,
  silenceClosingOf,
  languageCodes,
  spokenLines,
} from '@linedesk/actions'
import { voice } from '@livekit/agents'

/** A short pause after the last word, so the line does not cut the end of it. */
const AFTER_SPEECH_MS = 400
/** Longest the whole goodbye may take before the line is cut anyway. */
export const GOODBYE_MAX_MS = 20_000

/**
 * What end_call returns. The first call asks the caller whether there is anything else (the fixed line, closingFlow);
 * the next one, right after the caller answered it, says the goodbye line and hangs up. The model says nothing after
 * either: its reply to the tool is skipped (skipEndCallReplies).
 */
export const END_CALL_ASKED = 'The caller was asked whether there is anything else. Wait for their answer.'
export const END_CALL_ENDS = 'The goodbye is said and the call ends. Say nothing.'

/**
 * end_call written into the reply ("goodbye! {end_call}", "<end_call>", "[end_call()]"), as a realtime model sometimes does
 * instead of calling it, with the brackets around it.
 */
const END_CALL_IN_WORDS = /[{<[(]*\bend_call\b(?:\(\))?[}>\])]*/gi

/** Whether the assistant wrote end_call into its words instead of calling it: the call then ends all the same. */
export const writesEndCall = (text: string) => text.search(END_CALL_IN_WORDS) >= 0

/** A sentence in which the assistant says it hangs up now ("Alright, I'll hang up now.", also with a curly apostrophe), in the languages calls mostly use. */
const HANG_UP_ANNOUNCEMENT =
  /\b(?:I['’]?ll|I will|I['’]m going to|I am going to|let me) (?:now )?hang up\b|\bhanging up now\b|\b(?:voy a colgar|cuelgo ahora)\b|\bje (?:vais )?raccroche|\b(?:ich )?lege (?:jetzt |nun )?auf\b/i
/** Words that turn the sentence around ("I won't hang up", "don't hang up"). */
const NEGATION = /\b(?:not|never|won['’]t|don['’]t|nicht|pas)\b|n['’]t\b/i

/**
 * Whether the assistant said it hangs up now. The model sometimes says the hang-up line and leaves out end_call:
 * the call then ends after that line all the same.
 */
export function announcesHangUp(text: string): boolean {
  return text
    .split(/(?<=[.?!])\s+/)
    .some(sentence => !sentence.trim().endsWith('?') && HANG_UP_ANNOUNCEMENT.test(sentence) && !NEGATION.test(sentence))
}

/** The assistant's words without an end_call written into them, for the transcript. */
export const withoutEndCall = (text: string) => text.replace(END_CALL_IN_WORDS, '').trim()

/** A reply of the assistant, as the hang-up needs it (LiveKit's SpeechHandle). */
export type Reply = {
  done(): boolean
  addDoneCallback(callback: () => void): void
  readonly chatItems: readonly { id?: string; type: string; role?: string; textContent?: string }[]
}

/**
 * Once `reply` has played (or was cut off). Not `waitForPlayout()`: LiveKit refuses that from inside the tool that owns
 * the reply, which end_call is.
 */
export const playedOut = (reply: Reply) => new Promise<void>(resolve => (reply.done() ? resolve() : reply.addDoneCallback(() => resolve())))

/** The assistant's words in `reply`. */
export const wordsOf = (reply: Reply) =>
  reply.chatItems
    .filter(item => item.type === 'message' && item.role === 'assistant' && !!item.textContent?.trim())
    .map(item => item.textContent!.trim())
    .join(' ')

/** Whether the assistant said any words in `reply`. */
export const saidWords = (reply: Reply) => wordsOf(reply).length > 0

/** A goodbye in the languages calls mostly use: words with one of these end the call even when they ask something. */
const GOODBYE =
  /\b(?:good ?bye|bye|take care|have a (?:good|great|nice|lovely) (?:day|evening|night|weekend|one)|adi[oó]s|hasta luego|au revoir|bonne journ[ée]e|auf wiedersehen|auf wiederh[oö]ren|tsch[uü]ss|arrivederci|ciao|tchau|at[ée] logo|tot ziens|doei)\b/i
/** A request for something from the caller ("Please tell me…", "Go ahead."), in English and the languages calls mostly use. */
const REQUEST =
  /^(?:(?:so|okay|ok|alright|great|sure|perfect),?\s+)?(?:please\s+)?(?:(?:briefly|quickly|just)\s+)?(?:tell me|let me know|go ahead|describe|share|spell|give me|say)\b|\b(?:please|kindly)\s+(?:(?:briefly|quickly|just)\s+)?(?:tell|let me know|go ahead|describe|share|spell|give|say|leave)\b|\b(?:sagen sie|erz[aä]hlen sie|nennen sie|dites[- ]moi|d[ií]game|cu[eé]nteme|mi dica|me diga)\b/i

/** The last sentence of `text`. */
const lastSentence = (text: string) => text.trim().split(/(?<=[.?!。？！؟])\s*/).filter(s => s.trim()).at(-1)?.trim() ?? ''

/**
 * Whether the assistant's words ask the caller something, so the call must go on: the last sentence is a question (in
 * any script) or a request ("Please briefly tell me what you want the team to know."), and the words hold no goodbye.
 * A model sometimes calls end_call in the same reply as such a question (LIN-341): the caller would get no chance to
 * answer.
 */
export function asksCaller(text: string): boolean {
  const last = lastSentence(text)
  if (!last || GOODBYE.test(text)) return false
  return /[?？؟]$/.test(last) || REQUEST.test(last)
}

/**
 * Hangs up after the goodbye line (end_call's second call, or the assistant's words that say it hangs up now).
 * `toolReply`: the reply that called end_call, played out first; `said`: the words that end the call when no tool was
 * called. `sayGoodbye` says the goodbye line, unless those words said goodbye already (nothing is said twice).
 * `stopListening` once the goodbye starts: the caller can no longer cut it off or start another reply. At most `maxMs`
 * in all. Never after words that ask the caller something (asksCaller, LIN-341): then nothing is hung up and it
 * resolves false (the call goes on); true once the call ends.
 */
export async function hangUpWithGoodbye({
  toolReply,
  said = '',
  sayGoodbye,
  stopListening = () => {},
  hangUp,
  maxMs = GOODBYE_MAX_MS,
}: {
  toolReply: Reply | null
  said?: string
  sayGoodbye: () => Promise<unknown>
  stopListening?: () => void
  hangUp: () => void
  maxMs?: number
}) {
  let words = said
  if (toolReply) {
    await playedOut(toolReply)
    words = wordsOf(toolReply)
  }
  if (words && asksCaller(words)) return false
  let done = false
  const once = () => {
    if (done) return
    done = true
    hangUp()
  }
  setTimeout(once, maxMs).unref?.()
  stopListening()
  if (!GOODBYE.test(words))
    await sayGoodbye().catch(e => console.warn(`could not say the goodbye line: ${e instanceof Error ? e.message : String(e)}`))
  setTimeout(once, AFTER_SPEECH_MS).unref?.()
  return true
}

/**
 * The model's reply to end_call is skipped: end_call's own lines (the "anything else?" question, the goodbye) are what
 * the caller hears, so nothing is said twice.
 */
export function skipEndCallReplies(session: voice.AgentSession) {
  session.on(voice.AgentSessionEventTypes.FunctionToolsExecuted, event => {
    if (event.functionCalls.some(call => call.name === 'end_call')) event.cancelToolReply()
  })
}

/** "Anything else?" in the languages calls mostly use, for when the model asks it in its own words. */
const ANYTHING_ELSE =
  /\b(?:anything else|something else|anything more|etwas anderes|sonst noch|noch etwas|noch was|algo m[aá]s|otra cosa|autre chose|quelque chose d['’]autre|qualcos['’]altro|altro|mais alguma|outra coisa|iets anders|nog iets)\b/i

/** The fixed "anything else?" line in every language, as the assistant says it. */
const ANYTHING_ELSE_LINES = new Set(languageCodes.map(code => spokenLines(code).anythingElse))

/** Whether the assistant's words ask the caller whether there is anything else: the fixed line, or the model's own words. */
export const asksAnythingElse = (text: string) =>
  ANYTHING_ELSE_LINES.has(text.trim()) || (ANYTHING_ELSE.test(text) && asksCaller(text))

/**
 * The closing flow (LIN-358): the assistant hangs up only right after it asked whether there is anything else and the
 * caller answered. Decided by the assistant's last words before the reply that ends the call: when they were that
 * question, end_call says goodbye and hangs up; otherwise it asks it first. Any other words of the assistant after the
 * question (the caller had something more) mean it asks again. Decided by the assistant's words, not the caller's:
 * with a realtime model the caller's words often reach the transcript only after end_call ran.
 */
export function closingFlow() {
  const said: { id: string; question: boolean }[] = []
  // While the fixed question is being said: the messages that are not it (the reply that called end_call).
  let questionComing: ReadonlySet<string> | null = null
  return {
    /** Each of the assistant's messages, as it reaches the transcript. */
    assistantSaid(id: string, text: string) {
      const fixed = questionComing !== null && !questionComing.has(id)
      if (fixed) questionComing = null
      said.push({ id, question: fixed || asksAnythingElse(text) })
    },
    /**
     * The fixed question is being said: its message counts as the question in any wording (a realtime model may
     * translate it). `notIt`: the messages of the reply that called end_call.
     */
    questionComing(notIt: ReadonlySet<string> = new Set()) {
      questionComing = notIt
    },
    /** What end_call does now: `skip` are the messages of the reply that called it. */
    step(skip: ReadonlySet<string> = new Set()): 'ask' | 'hang_up' {
      const last = [...said].reverse().find(message => !skip.has(message.id))
      return last?.question ? 'hang_up' : 'ask'
    },
  }
}

export const STILL_THERE_LINE = 'Are you still there?'

/**
 * An assistant's silence settings (assistants.silence_*), with the defaults for anything missing. `reminder`: the
 * owner's own line, null for the default ("Are you still there?" in the language spoken at that moment).
 */
export type SilencePolicy = { firstGapS: number; reminders: number; hangUpS: number; reminder: string | null; closing: string }
export function silencePolicyOf(
  assistant: {
    silence_first_gap_s?: number | null
    silence_reminders?: number | null
    silence_hang_up_s?: number | null
    silence_reminder?: string | null
    silence_closing?: string | null
  } | null,
): SilencePolicy {
  return {
    firstGapS: assistant?.silence_first_gap_s ?? SILENCE_FIRST_GAP_DEFAULT_S,
    reminders: assistant?.silence_reminders ?? SILENCE_REMINDERS_DEFAULT,
    hangUpS: assistant?.silence_hang_up_s ?? SILENCE_HANG_UP_DEFAULT_S,
    reminder: assistant?.silence_reminder?.trim() || null,
    closing: silenceClosingOf(assistant?.silence_closing),
  }
}

/**
 * Seconds of silence at each step: a reminder every `firstGapS`, `reminders` times, then the closing line at `hangUpS`
 * (5, 10, 15 by default). A hang-up time that is not after the last reminder (an older API sends none) becomes one
 * gap after it.
 */
export function silenceSchedule({ firstGapS, reminders, hangUpS }: Pick<SilencePolicy, 'firstGapS' | 'reminders' | 'hangUpS'>): number[] {
  const asks = Array.from({ length: reminders }, (_, i) => firstGapS * (i + 1))
  const last = asks.at(-1) ?? firstGapS
  return [...asks, hangUpS > last ? hangUpS : last + firstGapS]
}

type UserStates = { on(event: voice.AgentSessionEventTypes.UserStateChanged, listener: (ev: { newState: string }) => void): unknown }

type SilenceOptions = {
  /** Asks the caller whether they are still there (the assistant's reminder line, else STILL_THERE_LINE). */
  remind: () => void
  /** Says the closing line and hangs up once it has played. */
  close: () => void
  /** Put through to a person: the assistant is out of the call, so silence on its side means nothing. */
  transferred: () => boolean
  /** On hold while a transfer rings: the caller is meant to be quiet; the reminders wait until the hold is over. */
  onHold?: () => boolean
  /**
   * Resolves once the greeting has played (greetingPlayed). Silence counts only from then: a greeting that is slow to
   * start (a busy server, a realtime model connecting) must not run down the caller's silence before they heard a word.
   */
  greeted?: Promise<unknown>
}

/**
 * Silence on the line. The session marks the caller "away" after `firstGapS` of silence on both sides (its away
 * timeout, set from the same policy): the assistant asks whether they are still there, again every `firstGapS`, up
 * to `reminders` times, and at `hangUpS` of silence says the closing line and hangs up (silenceSchedule). A word from
 * the caller starts it over. Never once the call was put through to a person, and not while the caller is on hold.
 * Nothing counts before the greeting has played: the schedule then starts from its end. Returns the stop for the end of
 * the call: a caller who hangs up during the silence must not get a reminder or a closing line (and a "Hung up after
 * silence" event later than the end) afterwards.
 */
export function remindOnSilence(session: UserStates, policy: Pick<SilencePolicy, 'firstGapS' | 'reminders' | 'hangUpS'>, { remind, close, transferred, onHold = () => false, greeted }: SilenceOptions) {
  const at = silenceSchedule(policy)
  let counting = !greeted
  let away = false
  let ended = false
  let next = 0
  let pending: ReturnType<typeof setTimeout> | undefined
  const stop = () => {
    clearTimeout(pending)
    pending = undefined
  }
  const after = (seconds: number) => {
    if (ended) return
    pending = setTimeout(step, seconds * 1000)
    pending.unref?.()
  }
  const step = () => {
    pending = undefined
    if (ended || transferred()) return
    if (onHold()) {
      // Silence while on hold is expected: start over once the hold is over.
      next = 0
      return after(policy.firstGapS)
    }
    if (next >= at.length - 1) {
      ended = true
      return close()
    }
    remind()
    next++
    after(at[next]! - at[next - 1]!)
  }
  session.on(voice.AgentSessionEventTypes.UserStateChanged, ({ newState }) => {
    away = newState === 'away'
    if (!away) {
      stop() // the caller spoke: still there, and the reminders start over
      next = 0
      return
    }
    if (pending || !counting) return
    // "Away" comes after the first gap: the first step is due now, or (no reminders) at the hang-up time.
    const wait = at[0]! - policy.firstGapS
    if (wait > 0) after(wait)
    else step()
  })
  void greeted?.then(() => {
    counting = true
    // Silent since before the greeting ended: the session reports no new "away", so the whole schedule counts from now.
    if (away && !pending && !ended) after(at[0]!)
  })
  return () => {
    ended = true
    stop()
  }
}

type AgentStates = {
  on(event: voice.AgentSessionEventTypes.AgentStateChanged, listener: (ev: { oldState: string }) => void): unknown
  off(event: voice.AgentSessionEventTypes.AgentStateChanged, listener: (ev: { oldState: string }) => void): unknown
}

/** Longest wait for the greeting to play before silence counts anyway: a greeting that never plays must not keep the call open. */
export const GREETING_PLAYOUT_MAX_MS = 60_000

/**
 * Resolves once the assistant's first speech (the greeting) has ended, played through or interrupted by the caller, at
 * the latest after `maxMs`.
 */
export function greetingPlayed(session: AgentStates, maxMs = GREETING_PLAYOUT_MAX_MS): Promise<void> {
  return new Promise(resolve => {
    const timer = setTimeout(done, maxMs)
    timer.unref?.()
    function done() {
      clearTimeout(timer)
      session.off(voice.AgentSessionEventTypes.AgentStateChanged, onState)
      resolve()
    }
    function onState({ oldState }: { oldState: string }) {
      if (oldState === 'speaking') done()
    }
    session.on(voice.AgentSessionEventTypes.AgentStateChanged, onState)
  })
}

/** The assistant's goodbye at ASSISTANT_CALL_MAX_MINUTES. */
export const CALL_LIMIT_LINE = "I'm sorry, we've reached the time limit for this call. I've noted everything for the team, and someone will get back to you. Goodbye!"
/** The goodbye when a test call from the web app reaches its limit. */
export const TEST_CALL_LIMIT_LINE = "This test call has reached its time limit, so I'll end it now. Goodbye!"
/** Longest wait for a fixed line (CALL_LIMIT_LINE, the closing line) to be spoken, from the start of its synthesis. */
export const LINE_PLAYOUT_MAX_MS = 15_000

/** Calls `hangUp` once `playout` is done (or failed), at the latest after `maxMs`. */
export function hangUpAfterLine(playout: Promise<unknown>, hangUp: () => void, maxMs = LINE_PLAYOUT_MAX_MS) {
  const cap = new Promise(resolve => setTimeout(resolve, maxMs).unref?.())
  void Promise.race([playout, cap]).catch(() => {}).then(hangUp)
}

/**
 * The call's last line: the closing line after silence, or the goodbye at the time limit. Whatever the assistant is still
 * saying, or about to say, is stopped first (`stopSpeaking`), and the caller is no longer listened to (`stopListening`):
 * a reply still playing at the limit would otherwise hold the line back, and the line's cap (LINE_PLAYOUT_MAX_MS, counted
 * from now) would cut it off (demo retest 2026-11-16: es-1, fr-1, ru-1). Once per call: the closing line and the time
 * limit coming together say only the first. Returns whether this line is said.
 */
export function lastLineOfCall({
  stopSpeaking,
  stopListening,
  say,
  hangUp,
  maxMs = LINE_PLAYOUT_MAX_MS,
}: {
  stopSpeaking: () => void
  stopListening: () => void
  say: (text: string) => Promise<unknown>
  hangUp: () => void
  maxMs?: number
}) {
  let said = false
  return (text: string) => {
    if (said) return false
    said = true
    for (const stop of [stopSpeaking, stopListening]) {
      try {
        stop()
      } catch (e) {
        console.warn(`before the last line: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    let playout: Promise<unknown>
    try {
      playout = say(text)
    } catch (e) {
      playout = Promise.reject(e)
    }
    hangUpAfterLine(playout, hangUp, maxMs)
    return true
  }
}

/**
 * How often ending the room is tried, how long each try may take (LiveKit's default is 10 s), and the pause before the
 * next try (doubled each time): 15 s at most in all, so a demo call whose last line ran to its cap still ends by the
 * stale-call sweep's backstop (apps/api demo-rooms.ts DEMO_ROOM_MAX_MS: DEMO_CALL_MAX_SECONDS + 30 s).
 */
export const ROOM_DELETE_ATTEMPTS = 3
export const ROOM_DELETE_TIMEOUT_MS = 4000
export const ROOM_DELETE_RETRY_MS = 1000

/** LiveKit's answer for a room that is gone already (the caller hung up first): nothing left to end. */
const roomGone = (e: unknown) =>
  !!e && typeof e === 'object' && ((e as { status?: unknown }).status === 404 || (e as { code?: unknown }).code === 'not_found')

/**
 * Ends the call for everyone by deleting its room. A failed delete (LiveKit's server API timing out on a busy network)
 * is tried again: before, it was only logged, and the call went on after its closing line (demo retest 2026-11-16, pt-1).
 * When every try fails, the agent leaves the call itself (`leave`): the assistant goes quiet and the call is finished;
 * the API's stale-call sweep removes the room. Resolves with how it ended.
 */
export async function endRoom({
  deleteRoom,
  leave,
  attempts = ROOM_DELETE_ATTEMPTS,
  retryMs = ROOM_DELETE_RETRY_MS,
  wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)),
}: {
  deleteRoom: () => Promise<unknown>
  leave: () => void
  attempts?: number
  retryMs?: number
  wait?: (ms: number) => Promise<unknown>
}): Promise<'deleted' | 'left'> {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await deleteRoom()
      return 'deleted'
    } catch (e) {
      if (roomGone(e)) return 'deleted'
      console.warn(`could not end the call's room (try ${attempt} of ${attempts}): ${e instanceof Error ? e.message : String(e)}`)
      if (attempt < attempts) await wait(retryMs * 2 ** (attempt - 1))
    }
  }
  leave()
  return 'left'
}

/**
 * Says goodbye and ends the call after `maxMs` (`goodbye` does both), unless it was put through to a person by then:
 * the limit is about what the assistant costs, and the trunk's CALL_MAX_MINUTES still ends that call. Returns the cancel.
 */
export function hangUpAtCallLimit(maxMs: number, { goodbye, transferred }: { goodbye: () => void; transferred: () => boolean }) {
  const timer = setTimeout(() => {
    if (!transferred()) goodbye()
  }, maxMs)
  timer.unref?.()
  return () => clearTimeout(timer)
}
