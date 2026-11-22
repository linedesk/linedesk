// A workspace's setup state, the one definition for everything that talks about it: the go-live checklist in the
// inbox (apps/web/src/inbox/goLive.ts, apps/api/src/go-live-checklist.ts), the setup emails and the at-risk list
// (apps/api/src/setup-emails.ts) and Server admin › Workspaces › At risk. Pure: the callers bring the facts (numbers, milestones,
// calls) from wherever they keep them.
import type { Call, PhoneNumber } from '@linedesk/db/types'

type Mode = PhoneNumber['mode']

/** A number the business forwards its own line to (all calls, or only the missed ones): it needs forwarding set up. */
export const forwardsCalls = (mode: Mode) => mode === 'forward_conditional' || mode === 'forward_all'

/**
 * Every call to the business reaches the assistant, not only the missed ones: forward all, and a new or ported
 * number that callers dial directly. Only conditional forwarding ("calls you don't pick up") takes part of them.
 */
export const takesAllCalls = (mode: Mode) => mode !== 'forward_conditional'

/**
 * "The" number setup is about: the oldest number in a forwarding mode, since its forwarding is what is still left to
 * do; without one, the oldest number. Null without numbers. Oldest by created_at, then id.
 */
export function setupNumber<N extends Pick<PhoneNumber, 'id' | 'mode' | 'created_at'>>(
  numbers: readonly N[],
): N | null {
  const oldestFirst = [...numbers].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id))
  return oldestFirst.find(n => forwardsCalls(n.mode)) ?? oldestFirst[0] ?? null
}

/**
 * A call from a real caller: an incoming phone call, not from the business's own phones, not spam. Only source
 * 'phone' counts: test, sample and simulated calls never do.
 */
export const isRealCall = (call: Pick<Call, 'source' | 'direction' | 'from_own_number' | 'outcome'>) =>
  call.source === 'phone' && call.direction === 'in' && !call.from_own_number && call.outcome !== 'spam'

/** The setup milestones (setup_events) that say a real caller reached the assistant. */
export const liveMilestones = ['first_real_call', 'activated'] as const

/**
 * Live: a real caller reached the assistant. The first_real_call or activated milestone, or a real call among the
 * calls (isRealCall: workspaces from before the milestones, or the browser's store before the server has answered).
 */
export const isLive = (milestones: { has(event: string): boolean }, hadRealCall: boolean) =>
  hadRealCall || liveMilestones.some(m => milestones.has(m))

/**
 * What is left before real callers reach the assistant, in order. `number`: none connected. `forwarding`: the setup
 * number forwards and forwarding is not verified yet (the check passed, or a real caller reached a forwarding
 * number). `first_call`: everything is in place, a real call has not come in yet.
 */
export type SetupStep = 'number' | 'forwarding' | 'first_call'

/** The next open setup step; null once the workspace is live. */
export function nextSetupStep(facts: {
  number: Pick<PhoneNumber, 'mode'> | null
  forwardingVerified: boolean
  live: boolean
}): SetupStep | null {
  if (facts.live) return null
  if (!facts.number) return 'number'
  if (forwardsCalls(facts.number.mode) && !facts.forwardingVerified) return 'forwarding'
  return 'first_call'
}

/**
 * Where a step is done in the web app (a hash path, without the #): the phone numbers, the setup number's
 * forwarding steps, or the inbox, where the first real call shows up.
 */
export function setupStepPath(step: SetupStep, number: Pick<PhoneNumber, 'id'> | null): string {
  if (step === 'number') return 'workspace/phone'
  if (step === 'forwarding') return number ? `workspace/phone/${encodeURIComponent(number.id)}` : 'workspace/phone'
  return 'calls'
}
