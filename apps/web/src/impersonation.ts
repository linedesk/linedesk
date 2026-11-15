// An instance admin signed in as another user (docs/architecture.md §12). Starting and stopping
// change which session the browser holds, so both end in a full reload; changes still waiting
// in the outbox are sent first, and the local data of the session that ends is deleted.
import { StepUpRequired, stepUpOf, withPasskeyStepUp } from './admin/PasskeyStepUp.tsx'
import { forgetLocalData } from './localData.ts'
import { flushAllStores } from './storeCache.ts'
import { brandName } from './brand.ts'
import { i18n } from './i18n/index.tsx'

type Person = { id: string; name: string; email: string }
/** From `/v1/me`: who is signed in as this user, and until when. */
export type Impersonation = { by: Person; user: Person; expiresAt: string }

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

export const confirmText = (name: string) =>
  i18n().t('admin.impersonation.confirm', { brand: brandName(), name })

export class UnsentChanges extends Error {}

const unsentText = (n: number) => i18n().t('shell.impersonation.unsent', { count: n })

async function post(path: string, body: unknown = {}) {
  const res = await fetch(path, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const json = (await res.json().catch(() => null)) as { ok?: boolean; error?: string; resumed?: boolean; code?: unknown; stepUp?: unknown } | null
  const stepUp = stepUpOf(json)
  if (stepUp) throw new StepUpRequired(json?.error ?? 'Confirm with your passkey.', stepUp)
  if (!res.ok || !json?.ok) throw new Error(json?.error ?? `The server answered ${res.status}`)
  return json
}

/** Reloads the app at `hash` (a plain hash change would keep the old session's state in memory). */
function reloadAt(hash: string) {
  window.history.replaceState(null, '', `${window.location.pathname}${hash}`)
  window.location.reload()
}

/** Signs this browser in as `userId` and opens their inbox. Throws with the reason when refused. */
export async function startImpersonation(userId: string) {
  const unsent = await flushAllStores()
  if (unsent > 0) throw new UnsentChanges(unsentText(unsent))
  await withPasskeyStepUp(() => post('/v1/impersonation/start', { userId }), 'sign in as this user')
  await forgetLocalData()
  reloadAt('#calls')
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
  await post('/v1/impersonation/stop')
  await forgetLocalData()
  reloadAt(`#admin/users/${encodeURIComponent(userId)}`)
}
