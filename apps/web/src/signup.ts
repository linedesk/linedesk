// The sign-up page's requests (apps/api/src/self-serve.ts and app.ts): whether sign-up is open, the email code with
// its checks, and account.signUp. What the page reads from its address: the plan and the interval, nothing else.
import { SIGNUP_COUNTRIES } from '@linedesk/db/types'

export { SIGNUP_COUNTRIES }

export type SignupConfig = { open: boolean; turnstileSiteKey: string | null }
export type CodeRefusal = 'closed' | 'invalid_email' | 'blocked_domain' | 'bot_check' | 'too_many' | 'busy'

/** `?plan=cloud&interval=year|month`; another plan (partner, postponed) is kept so the page can say "not yet". */
export function readSignupParams(search: string = window.location.search) {
  const query = new URLSearchParams(search)
  const plan = query.get('plan') ?? 'cloud'
  const interval: 'year' | 'month' = query.get('interval') === 'month' ? 'month' : 'year'
  return { plan, interval }
}

/** Whether this path is the sign-up page. */
export const isSignupPath = (path: string = window.location.pathname) => path.replace(/\/+$/, '') === '/signup'

export async function loadSignupConfig(): Promise<SignupConfig | 'unreachable'> {
  try {
    const res = await fetch('/v1/signup/config', { credentials: 'include' })
    if (!res.ok) return 'unreachable'
    const body = (await res.json()) as { open?: boolean; turnstileSiteKey?: string | null }
    return { open: body.open === true, turnstileSiteKey: body.turnstileSiteKey ?? null }
  } catch {
    return 'unreachable'
  }
}

const REFUSALS: readonly CodeRefusal[] = ['closed', 'invalid_email', 'blocked_domain', 'bot_check', 'too_many', 'busy']

/** Asks for an email code; the answer never says whether the address has an account. */
export async function askSignupCode(
  email: string,
  token: string,
): Promise<{ ok: true } | { ok: false; reason: CodeRefusal | 'unreachable' }> {
  try {
    const res = await fetch('/v1/signup/code', {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, token }),
    })
    if (res.ok) return { ok: true }
    const body = (await res.json().catch(() => null)) as { code?: string } | null
    const reason = REFUSALS.find(r => r === body?.code)
    return { ok: false, reason: reason ?? 'unreachable' }
  } catch {
    return { ok: false, reason: 'unreachable' }
  }
}

export type SignUpInput = {
  name: string
  businessName: string
  country: string
  plan: 'cloud'
  interval: 'year' | 'month'
  timeZone?: string
}

/** account.signUp through POST /v1/signup: the bill and the workspace, waiting for Checkout. */
export async function signUpBusiness(
  input: SignUpInput,
): Promise<{ ok: true; workspaceId: string } | { ok: false; notYet: boolean; closed: boolean }> {
  try {
    const res = await fetch('/v1/signup', {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    })
    const body = (await res.json().catch(() => null)) as { ok?: boolean; data?: { workspace?: { id: string } } } | null
    if (res.ok && body?.ok && body.data?.workspace) return { ok: true, workspaceId: body.data.workspace.id }
    // 409: the country is not served yet (the only state the handler refuses for); 403: closed meanwhile.
    return { ok: false, notYet: res.status === 409, closed: res.status === 403 }
  } catch {
    return { ok: false, notYet: false, closed: false }
  }
}
