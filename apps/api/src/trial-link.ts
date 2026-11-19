// The "Start your free trial" deep link (docs/billing.md §3.2): where the AI agent setup, the emails and the banners
// send the owner to start the trial. Opening it, the web app shows the Start your free trial dialog at once (signed
// out: after sign-in, at the same link), preselects the interval when one is given, and takes the flag out of the
// address. A trial that runs already shows Settings › Billing with a short note; anyone who cannot start it reads who
// can. The names are shared with the web app (@linedesk/actions, trial-link.ts).
import { type TrialInterval, trialStartHashPath } from '@linedesk/actions'

export { TRIAL_INTERVAL_PARAM, TRIAL_START_PARAM, type TrialInterval } from '@linedesk/actions'

/**
 * The path of the deep link on the web app's origin, e.g. `/#workspace/billing?start-trial=1&interval=year&ws=ws_1`.
 * `workspaceId`: the workspace's id, as every app link names a workspace (`ws=`; the app has no slug routes, so a
 * slug would not open it).
 */
export function trialStartPath(workspaceId: string, interval?: TrialInterval): string {
  return trialStartHashPath(workspaceId, interval)
}

/** The whole link on `origin` (the web app's, e.g. WEB_ORIGIN). */
export function trialStartUrl(origin: string, workspaceId: string, interval?: TrialInterval): string {
  return `${origin.replace(/\/+$/, '')}${trialStartPath(workspaceId, interval)}`
}
