// What the Account page shows, worked out from what Better Auth returns. No network here.
import { i18n } from '../../i18n/index.tsx'

export type LinkedAccount = { providerId: string }
/** A session as the page keeps it: no token, no IP address. */
export type SessionRow = { id: string; device: string; lastActive: Date; current: boolean }

const PASSWORD = 'credential'

export const hasPassword = (accounts: LinkedAccount[]) => accounts.some(a => a.providerId === PASSWORD)

// i18n-ignore: product names, never translated
const browsers: [RegExp, string][] = [
  [/Edg\//, 'Edge'],
  [/OPR\//, 'Opera'],
  [/Firefox\//, 'Firefox'],
  [/Chrome\//, 'Chrome'],
  [/Safari\//, 'Safari'],
]
// i18n-ignore: product names, never translated
const systems: [RegExp, string][] = [
  [/iPhone|iPad/, 'iOS'],
  [/Android/, 'Android'],
  [/Mac OS X|Macintosh/, 'macOS'],
  [/Windows/, 'Windows'],
  [/Linux/, 'Linux'],
]
const firstMatch = (table: [RegExp, string][], text: string) => table.find(([pattern]) => pattern.test(text))?.[1]

/** "Chrome on macOS" from a user agent; something readable for anything else. */
export function describeDevice(userAgent?: string | null): string {
  const { t } = i18n()
  if (!userAgent) return t('account.device.unknown')
  const browser = firstMatch(browsers, userAgent)
  const system = firstMatch(systems, userAgent)
  if (browser && system) return t('account.device.browserOn', { browser, system })
  // Neither a browser nor a system: a script or tool (curl, an SDK) signed in with the API.
  return browser ?? system ?? t('account.device.apiClient')
}

/** How many sessions the list shows before "Show N more". */
export const SESSIONS_SHOWN = 5

/** This device first, then the most recently used. */
export function orderSessions(sessions: SessionRow[]): SessionRow[] {
  return [...sessions].sort(
    (a, b) => Number(b.current) - Number(a.current) || b.lastActive.getTime() - a.lastActive.getTime(),
  )
}

export const MIN_PASSWORD_LENGTH = 8

/** Why this password form cannot be sent yet, or null when it can. */
export function passwordProblem(
  form: { current: string; next: string; repeat: string },
  needsCurrent: boolean,
): string | null {
  const { t } = i18n()
  if (needsCurrent && !form.current) return t('account.password.enterCurrent')
  if (form.next.length < MIN_PASSWORD_LENGTH) return t('account.password.tooShort', { count: MIN_PASSWORD_LENGTH })
  if (form.next !== form.repeat) return t('account.password.mismatch')
  if (needsCurrent && form.next === form.current) return t('account.password.sameAsCurrent')
  return null
}
