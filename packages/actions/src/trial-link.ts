// The "Start your free trial" deep link (docs/billing.md §3.2): a link the AI agent setup, the emails and the banners
// give the owner, which opens the Start your free trial dialog at once instead of making them look for its row. Shared
// by the API (apps/api/src/trial-link.ts builds it) and the web app (which reads it and then takes it out of the
// address). Only the flag, the interval and the workspace travel in the address, never personal data.

/** The hash parameter that asks the app to open the Start your free trial dialog (`start-trial=1`). */
export const TRIAL_START_PARAM = 'start-trial'

/** The hash parameter that preselects the plan's interval in that dialog (`interval=month|year`). */
export const TRIAL_INTERVAL_PARAM = 'interval'

/** The page the link points at: Workspace settings › Billing, where the bill lives once the trial runs. */
export const TRIAL_LINK_PAGE = 'workspace/billing'

/** The hash parameter that names the workspace a link is for (the web app's link handling reads it). */
export const TRIAL_LINK_WORKSPACE_PARAM = 'ws'

export type TrialInterval = 'month' | 'year'

/**
 * The deep link's path on the web app's origin: `/#workspace/billing?start-trial=1[&interval=month|year]&ws=<id>`.
 * `workspaceId`: the workspace's id, what `ws=` carries in every app link (the app has no slug routes).
 */
export function trialStartHashPath(workspaceId: string, interval?: TrialInterval): string {
  const params = new URLSearchParams({ [TRIAL_START_PARAM]: '1' })
  if (interval) params.set(TRIAL_INTERVAL_PARAM, interval)
  params.set(TRIAL_LINK_WORKSPACE_PARAM, workspaceId)
  return `/#${TRIAL_LINK_PAGE}?${params.toString()}`
}

/** The interval a link asks for, from the hash's query (`interval=month|year`); null for none or anything else. */
export function readTrialInterval(params: URLSearchParams): TrialInterval | null {
  const value = params.get(TRIAL_INTERVAL_PARAM)
  return value === 'month' || value === 'year' ? value : null
}
