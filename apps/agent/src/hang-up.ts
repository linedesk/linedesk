// How the assistant ends a call: always after saying something, never in the middle of it. After its own goodbye
// (end_call), after the closing line when the line stays silent, and after the goodbye at its time limit.
import {
  SILENCE_FIRST_GAP_DEFAULT_S,
  SILENCE_REMINDERS_DEFAULT,
  silenceClosingOf,
} from '@linedesk/actions'
import { voice } from '@livekit/agents'

/** Longest wait for the goodbye to finish playing before the line is cut anyway. */
export const GOODBYE_PLAYOUT_MAX_MS = 6000
/** A short pause after the last word, so the line does not cut the end of it. */
const AFTER_SPEECH_MS = 400
/** How long end_call waits for the goodbye the model said with it to start playing. */
const GOODBYE_START_WAIT_MS = 1500
/** Speech that ended this recently counts as the goodbye: nothing more is said before hanging up. */
const RECENT_SPEECH_MS = 4000
/** Said when end_call comes without a goodbye of the model's: a call never ends in silence. */
export const GOODBYE_LINE = 'Thanks for calling. Goodbye!'

type Speaking = {
  agentState: string
  /** Calls `listener` once the assistant is neither speaking nor thinking any more. */
  onDone(listener: () => void): void
  /** Whether the assistant's speech ended within the last `ms`. */
  spokeWithin(ms: number): boolean
}

/**
 * Hangs up after the assistant's goodbye: once it has played (after a short pause), at the latest after the cap. A
 * reply still being generated counts as the goodbye on its way. When nothing was said just before, `sayGoodbye` says
 * GOODBYE_LINE first.
 */
export function hangUpAfterSpeech(agent: Speaking, hangUp: () => void, sayGoodbye?: () => Promise<unknown>, maxMs = GOODBYE_PLAYOUT_MAX_MS) {
  let done = false
  const once = () => {
    if (done) return
    done = true
    hangUp()
  }
  const afterPause = () => setTimeout(once, AFTER_SPEECH_MS).unref?.()
  // After the model's last words, or with nothing said just before, GOODBYE_LINE first.
  const finish = () => {
    if (agent.spokeWithin(RECENT_SPEECH_MS + GOODBYE_START_WAIT_MS) || !sayGoodbye) return afterPause()
    hangUpAfterLine(sayGoodbye(), once)
  }
  // Speaking, or still thinking up the goodbye it says with end_call: wait for it, at most `maxMs`.
  const busy = () => agent.agentState === 'speaking' || agent.agentState === 'thinking'
  const afterReply = () => {
    setTimeout(once, maxMs).unref?.()
    agent.onDone(finish)
  }
  if (busy()) return afterReply()
  // The model's goodbye may still be on its way to the speaker: give it a moment to start.
  setTimeout(() => (busy() ? afterReply() : finish()), GOODBYE_START_WAIT_MS).unref?.()
}

/** The session as `hangUpAfterSpeech` needs it. */
export function speakingOf(session: voice.AgentSession, now = Date.now): Speaking {
  let lastSpokeAt = 0
  session.on(voice.AgentSessionEventTypes.AgentStateChanged, ({ oldState }: { oldState: string }) => {
    if (oldState === 'speaking') lastSpokeAt = now()
  })
  return {
    get agentState() {
      return session.agentState
    },
    onDone(listener) {
      const onState = ({ newState }: { newState: string }) => {
        if (newState === 'speaking' || newState === 'thinking') return
        session.off(voice.AgentSessionEventTypes.AgentStateChanged, onState)
        listener()
      }
      session.on(voice.AgentSessionEventTypes.AgentStateChanged, onState)
    },
    spokeWithin: ms => session.agentState === 'speaking' || now() - lastSpokeAt < ms,
  }
}

export const STILL_THERE_LINE = 'Are you still there?'

/** An assistant's silence settings (assistants.silence_*), with the defaults for anything missing. */
export type SilencePolicy = { firstGapS: number; reminders: number; closing: string }
export function silencePolicyOf(
  assistant: { silence_first_gap_s?: number | null; silence_reminders?: number | null; silence_closing?: string | null } | null,
): SilencePolicy {
  return {
    firstGapS: assistant?.silence_first_gap_s ?? SILENCE_FIRST_GAP_DEFAULT_S,
    reminders: assistant?.silence_reminders ?? SILENCE_REMINDERS_DEFAULT,
    closing: silenceClosingOf(assistant?.silence_closing),
  }
}

/** Seconds of silence before each step: reminders at the first gap, then twice as long each time, then the closing. */
export function silenceSchedule({ firstGapS, reminders }: Pick<SilencePolicy, 'firstGapS' | 'reminders'>): number[] {
  return Array.from({ length: reminders + 1 }, (_, i) => firstGapS * 2 ** i)
}

type UserStates = { on(event: voice.AgentSessionEventTypes.UserStateChanged, listener: (ev: { newState: string }) => void): unknown }

type SilenceOptions = {
  /** Asks the caller whether they are still there (STILL_THERE_LINE). */
  remind: () => void
  /** Says the closing line and hangs up once it has played. */
  close: () => void
  /** Put through to a person: the assistant is out of the call, so silence on its side means nothing. */
  transferred: () => boolean
}

/**
 * Silence on the line. The session marks the caller "away" after `firstGapS` of silence on both sides (its away
 * timeout, set from the same policy): the assistant asks whether they are still there, waits twice as long, asks
 * again, up to `reminders` times, then says the closing line and hangs up. A word from the caller starts it over.
 * Never once the call was put through to a person.
 */
export function remindOnSilence(session: UserStates, policy: Pick<SilencePolicy, 'firstGapS' | 'reminders'>, { remind, close, transferred }: SilenceOptions) {
  const [, ...waits] = silenceSchedule(policy)
  let ended = false
  let asked = 0
  let pending: ReturnType<typeof setTimeout> | undefined
  const stop = () => {
    clearTimeout(pending)
    pending = undefined
  }
  const step = () => {
    pending = undefined
    if (ended || transferred()) return
    if (asked >= policy.reminders) {
      ended = true
      return close()
    }
    remind()
    pending = setTimeout(step, waits[asked]! * 1000)
    pending.unref?.()
    asked++
  }
  session.on(voice.AgentSessionEventTypes.UserStateChanged, ({ newState }) => {
    if (newState !== 'away') {
      stop() // the caller spoke: still there, and the reminders start over
      asked = 0
      return
    }
    if (!pending) step()
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
