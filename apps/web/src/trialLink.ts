// The "Start your free trial" link (`#workspace/billing?start-trial=1[&interval=month|year]&ws=<id>`, docs/billing.md
// §3.2; built by apps/api/src/trial-link.ts): read once the session and its workspace are settled, then taken out of
// the address, so a reload or Back does not open the dialog again. Signed out, the address stays as it is, so signing
// in returns to the same link.
import { readTrialInterval, TRIAL_INTERVAL_PARAM, TRIAL_START_PARAM, type TrialInterval } from '@linedesk/actions'

export type TrialLinkRequest = { interval: TrialInterval | null }

/** What the address asks for: the dialog (with the interval to preselect), or null when it is no trial link. */
export function readTrialLink(hash: string): TrialLinkRequest | null {
  const at = hash.indexOf('?')
  if (at < 0) return null
  const params = new URLSearchParams(hash.slice(at + 1))
  if (params.get(TRIAL_START_PARAM) !== '1') return null
  return { interval: readTrialInterval(params) }
}

/** The hash without the link's own parameters (the flag and the interval); anything else in it stays. */
export function withoutTrialLink(hash: string): string {
  const at = hash.indexOf('?')
  if (at < 0) return hash
  const params = new URLSearchParams(hash.slice(at + 1))
  params.delete(TRIAL_START_PARAM)
  params.delete(TRIAL_INTERVAL_PARAM)
  const rest = params.toString()
  return `${hash.slice(0, at)}${rest ? `?${rest}` : ''}`
}

/**
 * Takes the request out of this page's address (replaceState: no navigation, no history entry). `to`: another hash
 * to land on instead (the waiting workspace has no Settings page to show yet).
 */
export function takeTrialLink(to?: string): TrialLinkRequest | null {
  if (typeof window === 'undefined') return null
  const found = readTrialLink(window.location.hash)
  if (!found) return null
  const next = to ?? withoutTrialLink(window.location.hash)
  window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.search}${next}`)
  return found
}

/**
 * Opened on a workspace whose trial or plan runs already: Settings › Billing shows a short note once. Kept in this
 * page only (the link is gone from the address once taken).
 */
let alreadyRunningNote = false
export const markAlreadyRunning = () => {
  alreadyRunningNote = true
}
export function takeAlreadyRunning(): boolean {
  const was = alreadyRunningNote
  alreadyRunningNote = false
  return was
}
