// The sign-up page's requests (apps/api/src/self-serve.ts and app.ts): whether sign-up is open, the email code with
// its checks, and account.signUp. What the page reads from its address: the plan and the interval, nothing else.
/** The plan's prices and the trial at the install's rules (Server admin › Billing), in cents before tax. */
export type SignupPlan = { monthlyCents: number; yearlyCents: number; trialDays: number }
/** The partner plan (docs/white-label.md): its base fee, and in the free trial at most `trialClients` client workspaces. */
export type PartnerSignupPlan = SignupPlan & { trialClients: number }
/** The terms and privacy policy the details step shows next to its button, and records as accepted (A9). */
export type SignupTerms = { termsUrl: string; termsVersion: string; privacyUrl: string; privacyVersion: string }
export type SignupConfig = {
  open: boolean
  turnstileSiteKey: string | null
  plan: SignupPlan | null
  partnerPlan: PartnerSignupPlan | null
  terms: SignupTerms | null
  /**
   * Whether this sign-up gets the free trial: false for a signed-in account that had one (one per account, decided by
   * the API again at account.signUp and Checkout); true signed out and from an older server.
   */
  trial: boolean
}
export type CodeRefusal = 'closed' | 'invalid_email' | 'blocked_domain' | 'bot_check' | 'too_many' | 'busy'

/** `?plan=cloud|partner&interval=year|month`; another plan is kept so the page can say "not yet". */
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
    const body = (await res.json()) as {
      open?: boolean
      turnstileSiteKey?: string | null
      plan?: SignupPlan | null
      partnerPlan?: PartnerSignupPlan | null
      terms?: SignupTerms | null
      trial?: boolean
    }
    const terms = body.terms ?? null
    return {
      // Open without terms cannot happen (the API closes sign-up then); the page treats it as closed.
      open: body.open === true && terms !== null,
      turnstileSiteKey: body.turnstileSiteKey ?? null,
      plan: readPlan(body.plan),
      partnerPlan: readPartnerPlan(body.partnerPlan),
      terms,
      trial: body.trial !== false,
    }
  } catch {
    return 'unreachable'
  }
}

/**
 * Opens the sign-up page from the app (the workspace menu's "New workspace…" for a Cloud customer): the same page
 * without the email step, at the interval of their bill; Back returns to the app (App.tsx follows the address).
 */
export function openSignup(interval: 'month' | 'year') {
  const from = `${window.location.pathname}${window.location.search}${window.location.hash}`
  window.history.pushState({ signupFrom: from }, '', `/signup?plan=cloud&interval=${interval}`)
  window.dispatchEvent(new PopStateEvent('popstate'))
}

/** Where Back on the sign-up page goes: the place in the app it was opened from, else the app's start. */
export function signupCameFrom(): string {
  const from = (window.history.state as { signupFrom?: unknown } | null)?.signupFrom
  return typeof from === 'string' && from.startsWith('/') && !from.startsWith('//') ? from : '/'
}

/** The plan in the config answer, when it is whole (an older server sends none). */
function readPlan(plan: SignupPlan | null | undefined): SignupPlan | null {
  if (!plan) return null
  const whole = (n: unknown) => typeof n === 'number' && Number.isInteger(n) && n >= 0
  return whole(plan.monthlyCents) && whole(plan.yearlyCents) && whole(plan.trialDays) ? plan : null
}

function readPartnerPlan(plan: PartnerSignupPlan | null | undefined): PartnerSignupPlan | null {
  const base = readPlan(plan)
  return base && plan && Number.isInteger(plan.trialClients) && plan.trialClients >= 0
    ? { ...base, trialClients: plan.trialClients }
    : null
}

const REFUSALS: readonly CodeRefusal[] = ['closed', 'invalid_email', 'blocked_domain', 'bot_check', 'too_many', 'busy']

/**
 * Asks for an email code; the answer never says whether the address has an account. The plan and interval go along so
 * the email's button opens this page with the same plan, in whichever browser opens it (apps/api/src/sign-in-link.ts).
 */
export async function askSignupCode(
  email: string,
  token: string,
  { plan, interval }: { plan: string; interval: 'year' | 'month' } = readSignupParams(),
): Promise<{ ok: true } | { ok: false; reason: CodeRefusal | 'unreachable' }> {
  try {
    const res = await fetch('/v1/signup/code', {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, token, plan, interval }),
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
  /** The partner's company name (plan `partner`); a business is named in the onboarding's Business step. */
  businessName?: string
  plan: 'cloud' | 'partner'
  interval: 'year' | 'month'
  /** This browser's time zone and language: where the request comes from when the proxy does not say (country-hint.ts). */
  timeZone?: string
  locale?: string
  acceptedTerms: { termsVersion: string; privacyVersion: string }
}

/**
 * account.signUp through POST /v1/signup: the bill and the workspace (or, plan `partner`, the partner), waiting for
 * Checkout. `partnerOwned`: this account owns a partner already.
 */
export async function signUpBusiness(
  input: SignUpInput,
): Promise<
  | { ok: true; workspaceId: string | null; partnerId: string | null }
  | { ok: false; notYet: boolean; closed: boolean; termsChanged: boolean; partnerOwned?: boolean }
> {
  try {
    const res = await fetch('/v1/signup', {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    })
    const body = (await res.json().catch(() => null)) as {
      ok?: boolean
      code?: string
      data?: { workspace?: { id: string } | null; partner?: { id: string } | null }
    } | null
    const workspaceId = body?.data?.workspace?.id ?? null
    const partnerId = body?.data?.partner?.id ?? null
    if (res.ok && body?.ok && (workspaceId || partnerId)) return { ok: true, workspaceId, partnerId }
    if (body?.code === 'already_partner')
      return { ok: false, notYet: false, closed: false, termsChanged: false, partnerOwned: true }
    // 409 with `terms_changed`: the terms changed while the page was open (A9); `country_not_served` (an older API: 409
    // without a code): the request comes from a country not served yet; 403: closed meanwhile.
    const termsChanged = res.status === 409 && body?.code === 'terms_changed'
    const notYet = body?.code === 'country_not_served' || (res.status === 409 && !body?.code)
    return { ok: false, notYet, closed: res.status === 403, termsChanged }
  } catch {
    return { ok: false, notYet: false, closed: false, termsChanged: false }
  }
}
