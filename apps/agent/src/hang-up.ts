// How the assistant ends a call: always after saying something, never in the middle of it. After its own goodbye
// (end_call), after the closing line when the line stays silent, and after the goodbye at its time limit.
import {
  SILENCE_FIRST_GAP_DEFAULT_S,
  SILENCE_HANG_UP_DEFAULT_S,
  SILENCE_REMINDERS_DEFAULT,
  silenceClosingOf,
} from '@linedesk/actions'
import { voice } from '@livekit/agents'

/** A short pause after the last word, so the line does not cut the end of it. */
const AFTER_SPEECH_MS = 400
/** How long end_call waits for the goodbye it asked for to start (as LiveKit's own end-call tool does). */
export const GOODBYE_REPLY_WAIT_MS = 5000
/** Longest the whole goodbye may take before the line is cut anyway. */
export const GOODBYE_MAX_MS = 20_000

/**
 * What end_call returns: the assistant's goodbye is its reply to the tool, said in the caller's language. The call ends
 * once it has played.
 */
export const END_CALL_RESULT =
  'In the language you are speaking with the caller, tell them you will hang up now and say goodbye (for example "Alright, I\'ll hang up now. Thanks for calling, goodbye!"). Say nothing else.'

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
  readonly chatItems: readonly { type: string; role?: string; textContent?: string }[]
}

/**
 * Once `reply` has played (or was cut off). Not `waitForPlayout()`: LiveKit refuses that from inside the tool that owns
 * the reply, which end_call is.
 */
const playedOut = (reply: Reply) => new Promise<void>(resolve => (reply.done() ? resolve() : reply.addDoneCallback(() => resolve())))

/** Whether the assistant said any words in `reply`. */
export const saidWords = (reply: Reply) =>
  reply.chatItems.some(item => item.type === 'message' && item.role === 'assistant' && !!item.textContent?.trim())

/**
 * Hangs up after the goodbye, the way LiveKit's own end-call tool does it: end_call asks for the goodbye (END_CALL_RESULT),
 * and the call ends once it has played, after a short pause. `toolReply`: the reply that called end_call, null when the
 * assistant's hang-up line ends the call; `goodbyeSaid`: that line has played already. `nextReply`: the goodbye a realtime
 * model says in a reply of its own, null when none starts within `waitMs`. With no words from the assistant at all,
 * `sayGoodbye` says the goodbye line: a call never ends in silence. `stopListening` once the goodbye starts: the caller
 can no longer cut it off or start another reply (not before: a "bye" they are still saying must end, or a realtime model
 waits for it and never says its goodbye). At most `maxMs` in all.
 */
export async function hangUpAfterGoodbye({
  toolReply,
  goodbyeSaid = false,
  nextReply,
  sayGoodbye,
  stopListening = () => {},
  hangUp,
  maxMs = GOODBYE_MAX_MS,
}: {
  toolReply: Reply | null
  goodbyeSaid?: boolean
  nextReply: (waitMs: number) => Promise<Reply | null>
  sayGoodbye: () => Promise<unknown>
  stopListening?: () => void
  hangUp: () => void
  maxMs?: number
}) {
  let done = false
  const once = () => {
    if (done) return
    done = true
    hangUp()
  }
  setTimeout(once, maxMs).unref?.()
  let said = goodbyeSaid
  if (!said && toolReply) {
    await playedOut(toolReply)
    said = saidWords(toolReply)
  }
  if (!said) {
    const reply = await nextReply(GOODBYE_REPLY_WAIT_MS)
    if (reply) {
      stopListening()
      await playedOut(reply)
      said = saidWords(reply)
    }
  }
  if (!said) {
    stopListening()
    await sayGoodbye().catch(e => console.warn(`could not say the goodbye line: ${e instanceof Error ? e.message : String(e)}`))
  }
  setTimeout(once, AFTER_SPEECH_MS).unref?.()
}

/**
 * The next reply the assistant starts (other than `toolReply`), listened for from now on, so a reply that starts before
 * anyone asks for it is not missed.
 */
export function nextReplyOf(session: voice.AgentSession, toolReply: Reply | null): (waitMs: number) => Promise<Reply | null> {
  let started: Reply | null = null
  let notify: ((reply: Reply) => void) | null = null
  const onCreated = ({ speechHandle }: { speechHandle: Reply }) => {
    if (speechHandle === toolReply || started) return
    started = speechHandle
    session.off(voice.AgentSessionEventTypes.SpeechCreated, onCreated)
    notify?.(speechHandle)
  }
  session.on(voice.AgentSessionEventTypes.SpeechCreated, onCreated)
  return waitMs =>
    new Promise(resolve => {
      if (started) return resolve(started)
      notify = resolve
      setTimeout(() => {
        session.off(voice.AgentSessionEventTypes.SpeechCreated, onCreated)
        resolve(started)
      }, waitMs).unref?.()
    })
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
 * Nothing counts before the greeting has played: the schedule then starts from its end.
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
