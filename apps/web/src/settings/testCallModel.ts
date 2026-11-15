// The test call without React: how long it may take and what its failures say.

import { i18n } from '../i18n/index.tsx'
import { whoSetsUp } from '../providerAudience.ts'

/** How long connecting, and then the assistant picking up, may take before the test call gives up. */
export const TEST_CALL_TIMEOUT_MS = 20_000

/**
 * How long the assistant may take to join the room once the browser is in it. On a busy server the agent takes 5 to
 * 8 seconds to join, so this leaves room; after SLOW_JOIN_MS the panel says it is still connecting.
 */
export const PICKUP_TIMEOUT_MS = 20_000
/** Not joined after this long: the panel says "Still connecting…" (not a verdict; that comes at PICKUP_TIMEOUT_MS). */
export const SLOW_JOIN_MS = 8_000
/** How long, from the start, the assistant may take to say something: a late join still leaves time for the greeting. */
export const ANSWER_TIMEOUT_MS = PICKUP_TIMEOUT_MS + 10_000
/** A normal hang-up closes the room right after the assistant leaves; still open this much later, it dropped out. */
export const AGENT_LEFT_GRACE_MS = 3_000

/**
 * No agent joined the room within PICKUP_TIMEOUT_MS: the voice agent is not running, or LiveKit sent the call to no
 * worker (overloaded). `operator`: the member runs the server and can fix it.
 */
export const noJoinText = (name: string, operator: boolean) =>
  i18n().t(operator ? 'settings.testCall.noJoinOperator' : 'settings.testCall.noJoin', { name })

/** The assistant joined but stayed silent. `operator`: the member runs the server and can fix it. */
export const noPickupText = (name: string, operator: boolean) =>
  i18n().t(operator ? 'settings.testCall.noPickupOperator' : 'settings.testCall.noPickup', { name })

/** The assistant left while the call was still on. */
export const agentLeftText = (name: string, operator: boolean) =>
  i18n().t(operator ? 'settings.testCall.agentLeftOperator' : 'settings.testCall.agentLeft', { name })

export type PickupWatch = {
  /** Starts the clocks: once the browser is in the room. What was seen before counts. */
  start: () => void
  /** The assistant joined the room. */
  joined: () => void
  /** Something came from the assistant: its audio, or the call it filed. */
  heard: () => void
  /** The assistant left the room. */
  left: () => void
  /** The call ended (hang-up, room closed): nothing more fires. */
  stop: () => void
}

/**
 * Whether the assistant picks up a test call and stays: `noJoin` when it has not joined `pickupMs` after the start,
 * `noPickup` when nothing came from it after `answerMs`; `agentLeft` when it left and the call did not end within
 * `leftGraceMs`. At most one of them fires, once. `slow(true)` when it has not joined `slowMs` after the start (no
 * verdict, the call goes on), and `slow(false)` once that is over.
 */
export function watchPickup(
  on: { noJoin: () => void; noPickup: () => void; agentLeft: () => void; slow?: (slow: boolean) => void },
  ms = { slow: SLOW_JOIN_MS, pickup: PICKUP_TIMEOUT_MS, answer: ANSWER_TIMEOUT_MS, leftGrace: AGENT_LEFT_GRACE_MS },
): PickupWatch {
  let started = false
  let done = false
  let joined = false
  let heard = false
  let slow = false
  const timers: Record<'slow' | 'pickup' | 'answer' | 'left', ReturnType<typeof setTimeout> | undefined> = {
    slow: undefined,
    pickup: undefined,
    answer: undefined,
    left: undefined,
  }
  const clear = (name: keyof typeof timers) => {
    clearTimeout(timers[name])
    timers[name] = undefined
  }
  const notSlow = () => {
    clear('slow')
    if (!slow) return
    slow = false
    on.slow?.(false)
  }
  const stop = () => {
    done = true
    for (const name of ['slow', 'pickup', 'answer', 'left'] as const) clear(name)
    notSlow()
  }
  const verdict = (fire: () => void) => () => {
    if (done) return
    stop()
    fire()
  }
  return {
    start: () => {
      if (started || done) return
      started = true
      if (!joined && !heard) {
        timers.pickup = setTimeout(verdict(on.noJoin), ms.pickup)
        timers.slow = setTimeout(() => {
          timers.slow = undefined
          if (done || joined || heard) return
          slow = true
          on.slow?.(true)
        }, ms.slow)
      }
      if (!heard) timers.answer = setTimeout(verdict(on.noPickup), ms.answer)
    },
    joined: () => {
      joined = true
      clear('pickup')
      notSlow()
    },
    heard: () => {
      heard = true
      clear('pickup')
      clear('answer')
      notSlow()
    },
    left: () => {
      if (done || timers.left) return
      notSlow()
      clear('pickup')
      clear('answer')
      timers.left = setTimeout(verdict(on.agentLeft), ms.leftGrace)
    },
    stop,
  }
}

/** The server's refusal in words for the business; LiveKit and other internals stay out. */
export function testCallErrorText(error: string): string {
  const { t } = i18n()
  if (/not set up|not configured/i.test(error)) return t('settings.testCall.notSetUp', { who: whoSetsUp('voice') })
  // Nobody would answer (apps/api/src/test-call.ts): the why for the operator, a plain sentence for everyone else.
  if (/voice agent|test calls aren't available/i.test(error)) return error
  if (/too many test calls/i.test(error)) return t('settings.testCall.tooMany')
  // The daily limits (apps/api/src/test-call.ts) are written for people: shown as they are.
  if (/test calls today|as many test calls today|monthly spending cap/i.test(error)) return error
  return t('settings.testCall.couldNotStart')
}

export class TimedOut extends Error {}

/** Rejects with TimedOut after `ms`, so a hung connection ends with a clear message. */
export function within<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimedOut()), ms)
  })
  return Promise.race([work, late]).finally(() => clearTimeout(timer))
}
