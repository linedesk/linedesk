// The test call without React: how long it may take and what its failures say.

import { whoSetsUp } from '../providerAudience.ts'

/** How long connecting, and then the assistant picking up, may take before the test call gives up. */
export const TEST_CALL_TIMEOUT_MS = 20_000

/** How long the assistant may take to join the room once the browser is in it. */
export const PICKUP_TIMEOUT_MS = 8_000
/** A normal hang-up closes the room right after the assistant leaves; still open this much later, it dropped out. */
export const AGENT_LEFT_GRACE_MS = 3_000

/** The assistant never joined, or joined and stayed silent. `operator`: the member runs the server and can fix it. */
export const noPickupText = (name: string, operator: boolean) =>
  operator
    ? `${name} didn't pick up. The voice agent may not be running: Admin › Overview shows its health.`
    : `${name} didn't pick up. Try again in a moment, or ask whoever runs this server if it keeps happening.`

/** The assistant left while the call was still on. */
export const agentLeftText = (name: string, operator: boolean) =>
  operator
    ? `${name} left the call unexpectedly. The voice agent may have stopped: Admin › Overview shows its health.`
    : `${name} left the call unexpectedly. Try again in a moment.`

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
 * Whether the assistant picks up a test call and stays: `noPickup` when it has not joined `pickupMs` after the start,
 * or nothing came from it after `answerMs`; `agentLeft` when it left and the call did not end within `leftGraceMs`.
 * At most one of them fires, once.
 */
export function watchPickup(
  on: { noPickup: () => void; agentLeft: () => void },
  ms = { pickup: PICKUP_TIMEOUT_MS, answer: TEST_CALL_TIMEOUT_MS, leftGrace: AGENT_LEFT_GRACE_MS },
): PickupWatch {
  let started = false
  let done = false
  let joined = false
  let heard = false
  const timers: Record<'pickup' | 'answer' | 'left', ReturnType<typeof setTimeout> | undefined> = {
    pickup: undefined,
    answer: undefined,
    left: undefined,
  }
  const clear = (name: keyof typeof timers) => {
    clearTimeout(timers[name])
    timers[name] = undefined
  }
  const stop = () => {
    done = true
    for (const name of ['pickup', 'answer', 'left'] as const) clear(name)
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
      if (!joined && !heard) timers.pickup = setTimeout(verdict(on.noPickup), ms.pickup)
      if (!heard) timers.answer = setTimeout(verdict(on.noPickup), ms.answer)
    },
    joined: () => {
      joined = true
      clear('pickup')
    },
    heard: () => {
      heard = true
      clear('pickup')
      clear('answer')
    },
    left: () => {
      if (done || timers.left) return
      clear('pickup')
      clear('answer')
      timers.left = setTimeout(verdict(on.agentLeft), ms.leftGrace)
    },
    stop,
  }
}

/** The server's refusal in words for the business; LiveKit and other internals stay out. */
export function testCallErrorText(error: string): string {
  if (/not set up|not configured/i.test(error))
    return `Test calls aren't set up on this server yet. ${whoSetsUp('the voice services')}`
  // Nobody would answer (apps/api/src/test-call.ts): the why for the operator, a plain sentence for everyone else.
  if (/voice agent|test calls aren't available/i.test(error)) return error
  if (/too many test calls/i.test(error)) return 'Too many test calls in a short time. Try again in a few minutes.'
  // The daily limits (apps/api/src/test-call.ts) are written for people: shown as they are.
  if (/test calls today|as many test calls today|monthly spending cap/i.test(error)) return error
  return "The test call couldn't start. Try again in a moment."
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
