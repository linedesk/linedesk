// Asking members without a passkey to add one (LIN-215). Right after signing in another way (email code, password,
// a provider, an invitation) the app shows one calm "Add a passkey" page (AddPasskey.tsx); later a quiet card in the
// app reminds them. "Not now" pauses both for this account on this device for PAUSE_DAYS. Never blocking: everything
// here is a per-device convenience, so storage may be missing or blocked (private window) and every access is guarded.

/** How long "Not now" keeps the page and the card away. */
export const PAUSE_DAYS = 14
const PAUSE_MS = PAUSE_DAYS * 24 * 60 * 60 * 1000

const DUE_KEY = 'linedesk.passkeyAsk.afterSignIn'
const pausedKey = (account: string) => `linedesk.passkeyAsk.notNow.${account}`

/** What to show: the page right after signing in, the quiet card in the app, or nothing. */
export type PasskeyAsk = 'prompt' | 'nudge' | null

export type PasskeyAskInput = {
  /** From /v1/me: false without a passkey; null when this install has passkeys off; undefined from an older version. */
  hasPasskey: boolean | null | undefined
  /** This browser can use passkeys (WebAuthn on https or localhost). */
  supported: boolean
  /** An instance admin signed in as this member: never asked for them. */
  impersonating: boolean
  /** The address is not confirmed yet: the server refuses a passkey until it is. */
  emailUnconfirmed: boolean
  /** An instance admin's first passkey needs an enrolment code: only Account › Sign-in & security asks for it. */
  needsEnrolmentCode: boolean
  /** This device just signed in without a passkey (markSignedIn). */
  justSignedIn: boolean
  /** When this account last chose "Not now" on this device (ms), or null. */
  pausedAt: number | null
  now: number
}

/** Whether to ask, and how. */
export function passkeyAsk(input: PasskeyAskInput): PasskeyAsk {
  if (input.hasPasskey !== false) return null
  if (!input.supported || input.impersonating || input.emailUnconfirmed) return null
  if (input.pausedAt !== null && input.pausedAt <= input.now && input.now - input.pausedAt < PAUSE_MS) return null
  // The admin's code field lives in Account settings: the card links there, the page would only send them away.
  if (input.justSignedIn && !input.needsEnrolmentCode) return 'prompt'
  return 'nudge'
}

function read(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}
function write(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key)
    else localStorage.setItem(key, value)
  } catch {
    // Without storage the page may show once more, or not at all; neither blocks anyone.
  }
}

/**
 * A sign-in on this device just happened (sign-in-methods.ts). Another way than a passkey: the page is due once the
 * app has the account; a passkey: it is not (they have one).
 */
export function markSignedIn(method: string) {
  write(DUE_KEY, method === 'passkey' ? null : '1')
}

/** Whether a sign-in without a passkey is waiting for its page. */
export const signedInJustNow = () => read(DUE_KEY) === '1'

/** The page was answered, or is not needed: it does not come back until the next sign-in. */
export const clearSignedIn = () => write(DUE_KEY, null)

/** When this account chose "Not now" on this device, or null. */
export function pausedAt(account: string): number | null {
  const value = Number(read(pausedKey(account)))
  return Number.isFinite(value) && value > 0 ? value : null
}

/** "Not now": no page and no card for PAUSE_DAYS on this device. */
export function pause(account: string, now = Date.now()) {
  write(pausedKey(account), String(now))
  clearSignedIn()
}
