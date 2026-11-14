// The first admin's passkey enrolment code (LIN-189): POST /v1/setup returns it to the browser that entered the setup
// code, and Account › Sign-in & security › Add passkey fills it in. Kept in sessionStorage (this tab only, gone when it
// closes), never in localStorage, and only until the passkey is added, it expires, or the admin signs out.
const KEY = 'linedesk.passkeyEnrolment'

export type EnrolmentCode = { enrolmentCode: string; enrolmentExpiresAt: string }

const storage = (): Storage | null => {
  try {
    return sessionStorage
  } catch {
    return null
  }
}

/** Keeps the code from the setup answer; null (no passkey needed on this install) keeps nothing. */
export function rememberEnrolmentCode(enrolment: EnrolmentCode | null | undefined, store = storage()) {
  if (!store || !enrolment?.enrolmentCode) return
  try {
    store.setItem(KEY, JSON.stringify(enrolment))
  } catch {
    // Storage full or blocked: the admin can still get a code with user:passkeys --enrol.
  }
}

/** The kept code while it has not expired; an expired or unreadable one is removed. */
export function readEnrolmentCode(store = storage(), now = Date.now()): string | null {
  if (!store) return null
  try {
    const kept = JSON.parse(store.getItem(KEY) ?? 'null') as Partial<EnrolmentCode> | null
    if (!kept) return null
    const expires = Date.parse(kept.enrolmentExpiresAt ?? '')
    if (typeof kept.enrolmentCode === 'string' && kept.enrolmentCode && Number.isFinite(expires) && expires > now)
      return kept.enrolmentCode
  } catch {
    // Not ours or broken: drop it.
  }
  forgetEnrolmentCode(store)
  return null
}

/** The passkey was added (the code is used up) or the admin signed out. */
export function forgetEnrolmentCode(store = storage()) {
  try {
    store?.removeItem(KEY)
  } catch {
    // Nothing to do.
  }
}
