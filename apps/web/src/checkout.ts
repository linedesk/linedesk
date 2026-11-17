// Trial Checkout (docs/billing.md §3.2, apps/api/src/billing-checkout.ts): the bill's owner goes to Stripe Checkout
// and comes back to /billing/return?session_id=…, where the app confirms it. Only the session id travels in the
// address; the server checks that it is this bill's.
import type { CheckoutConfirmData, CheckoutStartData } from '@linedesk/actions'
import { callAction } from './settings/settings-api.ts'

/** Whether this path is the page Checkout returns to. */
export const isCheckoutReturnPath = (path: string = window.location.pathname) =>
  path.replace(/\/+$/, '') === '/billing/return'

/** The Checkout session id in the return address, or null (only Stripe's `cs_…` ids). */
export function readCheckoutSession(search: string = window.location.search): string | null {
  const id = new URLSearchParams(search).get('session_id')
  return id && /^cs_[A-Za-z0-9_]{1,250}$/.test(id) ? id : null
}

/** Starts Checkout for the bill (the trial, or the plan after a refused trial) and goes there. */
export async function goToCheckout() {
  const { url } = await callAction<CheckoutStartData>('billing.startCheckout')
  window.location.assign(url)
}

export type ConfirmOutcome = CheckoutConfirmData | { status: 'not_found' } | { status: 'failed' }

/**
 * The confirmation asked for each session in this page: the return page asks once, however often it mounts (React's
 * StrictMode runs its effect twice), so the server runs and audits `billing.confirmCheckout` once per return.
 */
const confirming = new Map<string, Promise<ConfirmOutcome>>()

/**
 * Confirms the finished Checkout; a session that is not this bill's answers `not_found`, like an unknown one. Asked
 * once per session id; a failure is not kept, so a later try asks again.
 */
export function confirmCheckout(sessionId: string): Promise<ConfirmOutcome> {
  const asked = confirming.get(sessionId)
  if (asked) return asked
  const answer = askConfirm(sessionId).then(outcome => {
    if (outcome.status === 'failed') confirming.delete(sessionId)
    return outcome
  })
  confirming.set(sessionId, answer)
  return answer
}

async function askConfirm(sessionId: string): Promise<ConfirmOutcome> {
  try {
    return await callAction<CheckoutConfirmData>('billing.confirmCheckout', { sessionId })
  } catch (error) {
    return { status: (error as { code?: string }).code === 'not_found' ? 'not_found' : 'failed' }
  }
}
