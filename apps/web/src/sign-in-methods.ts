// Which sign-in method this device used last, for the "Last used" badge. A per-device convenience only:
// storage may be missing or blocked (private window, cleared data), so every access is guarded.
export type SignInMethodId = 'email' | 'password' | string

const LAST_USED_KEY = 'linedesk.lastSignInMethod'

export function readLastUsedMethod(): SignInMethodId | null {
  try {
    return localStorage.getItem(LAST_USED_KEY)
  } catch {
    return null
  }
}

export function rememberSignInMethod(method: SignInMethodId) {
  try {
    localStorage.setItem(LAST_USED_KEY, method)
  } catch {
    // Without storage the badge just does not show.
  }
}
