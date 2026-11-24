// An instance admin signed in as another user (docs/architecture.md §12). Starting and stopping
// change which session the browser holds, so both end in a full reload; changes still waiting
// in the outbox are sent first, and the local data of the session that ends is deleted.
import { IMPERSONATION_REASON_MAX, IMPERSONATION_REASON_MIN } from '@linedesk/actions'
import { StepUpRequired, stepUpOf, withPasskeyStepUp } from './admin/PasskeyStepUp.tsx'
import { holdQueries, releaseQueries } from './cachedQuery.ts'
import { forgetLocalData } from './localData.ts'
import { flushAllStores } from './storeCache.ts'
import { brandName } from './brand.ts'
import { i18n } from './i18n/index.tsx'

type Person = { id: string; name: string; email: string }
/**
 * From `/v1/me`: who is signed in as this user, and until when. `edits`: the admin allowed edits of the assistant's and
 * workspace's settings (impersonation.setEdits); otherwise everything but inbox triage and API keys is read-only.
 */
export type Impersonation = { by: Person; user: Person; expiresAt: string; edits?: boolean }

/** Whole minutes left, rounded up; 0 once it has ended. */
export const minutesLeft = (expiresAt: string, now: Date) =>
  Math.max(0, Math.ceil((Date.parse(expiresAt) - now.getTime()) / 60_000))

export const remainingText = (minutes: number) =>
  minutes <= 0 ? i18n().t('shell.impersonation.ending') : i18n().t('shell.impersonation.minutesLeft', { minutes })

const nameOf = (p: Pick<Person, 'name' | 'email'>) => p.name || p.email

/** The banner's parts: whose session this is and which admin is in it. */
export const bannerText = (imp: Impersonation) => ({
  who: i18n().t('shell.impersonation.who', { name: nameOf(imp.user) }),
  /** Only when the name is shown: someone without a name is already named by their email. */
  email: imp.user.name ? imp.user.email : null,
  by: i18n().t('shell.impersonation.by', { name: nameOf(imp.by) }),
})

export const confirmText = (name: string) => i18n().t('admin.impersonation.confirm', { brand: brandName(), name })

/** The reason the start asks for (user.impersonate): kept in the audit log, and in the email to the user when that is on. */
export const reasonField = () => ({
  label: i18n().t('admin.impersonation.reason'),
  placeholder: i18n().t('admin.impersonation.reasonPlaceholder'),
  min: IMPERSONATION_REASON_MIN,
  max: IMPERSONATION_REASON_MAX,
})

export class UnsentChanges extends Error {}

const unsentText = (n: number) => i18n().t('shell.impersonation.unsent', { count: n })

async function post(path: string, body: unknown = {}) {
  const res = await fetch(path, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const json = (await res.json().catch(() => null)) as {
    ok?: boolean
    error?: string
    resumed?: boolean
    code?: unknown
    stepUp?: unknown
  } | null
  const stepUp = stepUpOf(json)
  if (stepUp) throw new StepUpRequired(json?.error ?? i18n().t('admin.api.confirmPasskey'), stepUp)
  if (!res.ok || !json?.ok) throw new Error(json?.error ?? i18n().t('admin.api.serverAnswered', { status: res.status }))
  return json
}

/**
 * Runs the request that switches this browser's session: from then on until the reload, no cached query loads as the
 * old account (holdQueries). Refused, the page stays as it was and loads again.
 */
export async function whileSessionChanges<T>(change: () => Promise<T>): Promise<T> {
  holdQueries()
  try {
    return await change()
  } catch (e) {
    releaseQueries()
    throw e
  }
}

/**
 * Once the session has switched: forgets this browser's data for the old one, then reloads whatever happens. A failed
 * clean-up resumes the held queries first, so the page never stays on held answers of the old account (security
 * review #854, L2).
 */
export async function afterSessionChange(cleanUp: () => Promise<void>, reload: () => void): Promise<void> {
  try {
    await cleanUp()
  } catch (e) {
    releaseQueries()
    console.warn(`could not forget the local data before the reload: ${e instanceof Error ? e.message : String(e)}`)
  } finally {
    reload()
  }
}

/** Reloads the app at `hash` (a plain hash change would keep the old session's state in memory). */
function reloadAt(hash: string) {
  window.history.replaceState(null, '', `${window.location.pathname}${hash}`)
  window.location.reload()
}

/**
 * Signs this browser in as `userId` and opens their inbox, in `workspaceId` when given (one of theirs: Server admin ›
 * Workspaces › Sign in as owner), else their first. `reason` is kept in the audit log. Throws with the reason when refused.
 */
export async function startImpersonation(userId: string, reason: string, workspaceId?: string) {
  const unsent = await flushAllStores()
  if (unsent > 0) throw new UnsentChanges(unsentText(unsent))
  await whileSessionChanges(() =>
    withPasskeyStepUp(
      () => post('/v1/impersonation/start', { userId, reason, ...(workspaceId ? { workspaceId } : {}) }),
      i18n().t('admin.stepUp.what.impersonate'),
    ),
  )
  await afterSessionChange(forgetLocalData, () => reloadAt('#calls'))
}

/**
 * Back to the admin's own session, at the user's page in Server admin. If that session cannot be resumed,
 * the browser is signed out and the reload shows sign-in. With `discardUnsent`, changes that could
 * not be sent are dropped.
 */
export async function stopImpersonation(userId: string, discardUnsent = false) {
  const unsent = await flushAllStores()
  if (unsent > 0 && !discardUnsent)
    throw new UnsentChanges(unsentText(unsent).replace('then try again', 'or return again to discard them'))
  await whileSessionChanges(() => post('/v1/impersonation/stop'))
  await afterSessionChange(forgetLocalData, () => reloadAt(`#admin/users/${encodeURIComponent(userId)}`))
}
