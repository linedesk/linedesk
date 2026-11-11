// What the Account page shows, worked out from what Better Auth returns. No network here.
import type { AuthMethods } from '../../auth.ts'

export type LinkedAccount = { providerId: string }
/** A session as the page keeps it: no token, no IP address. */
export type SessionRow = { id: string; device: string; lastActive: Date; current: boolean }

const PASSWORD = 'credential'

export const hasPassword = (accounts: LinkedAccount[]) => accounts.some(a => a.providerId === PASSWORD)

/** Every way this member can sign in on this install, in a fixed order: "Password", "Google", ..., "Email code". */
export function signInMethodLabels(accounts: LinkedAccount[], methods: AuthMethods): string[] {
  const names: Record<string, string> = {
    [PASSWORD]: 'Password', google: 'Google', microsoft: 'Microsoft', github: 'GitHub',
    oidc: methods.sso.find(m => m.id === 'oidc')?.label ?? 'Single sign-on',
  }
  const linked = new Set(accounts.map(a => a.providerId))
  const usable = (id: string) => linked.has(id) && (id !== PASSWORD || methods.password)
  const labels = Object.keys(names).filter(usable).map(id => names[id]!)
  return methods.emailCode ? [...labels, 'Email code'] : labels
}

const browsers: [RegExp, string][] = [[/Edg\//, 'Edge'], [/OPR\//, 'Opera'], [/Firefox\//, 'Firefox'], [/Chrome\//, 'Chrome'], [/Safari\//, 'Safari']]
const systems: [RegExp, string][] = [[/iPhone|iPad/, 'iOS'], [/Android/, 'Android'], [/Mac OS X|Macintosh/, 'macOS'], [/Windows/, 'Windows'], [/Linux/, 'Linux']]
const firstMatch = (table: [RegExp, string][], text: string) => table.find(([pattern]) => pattern.test(text))?.[1]

/** "Chrome on macOS" from a user agent; something readable for anything else. */
export function describeDevice(userAgent?: string | null): string {
  if (!userAgent) return 'Unknown device'
  const browser = firstMatch(browsers, userAgent)
  const system = firstMatch(systems, userAgent)
  if (browser && system) return `${browser} on ${system}`
  // Neither a browser nor a system: a script or tool (curl, an SDK) signed in with the API.
  return browser ?? system ?? 'API client'
}

/** How many sessions the list shows before "Show N more". */
export const SESSIONS_SHOWN = 5

/** This device first, then the most recently used. */
export function orderSessions(sessions: SessionRow[]): SessionRow[] {
  return [...sessions].sort((a, b) => Number(b.current) - Number(a.current) || b.lastActive.getTime() - a.lastActive.getTime())
}

export const MIN_PASSWORD_LENGTH = 8

/** Why this password form cannot be sent yet, or null when it can. */
export function passwordProblem(form: { current: string; next: string; repeat: string }, needsCurrent: boolean): string | null {
  if (needsCurrent && !form.current) return 'Enter your current password.'
  if (form.next.length < MIN_PASSWORD_LENGTH) return `Use at least ${MIN_PASSWORD_LENGTH} characters.`
  if (form.next !== form.repeat) return 'The two new passwords do not match.'
  if (needsCurrent && form.next === form.current) return 'The new password is the same as the current one.'
  return null
}
