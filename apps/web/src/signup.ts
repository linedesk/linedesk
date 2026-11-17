// The sign-up page's requests (apps/api/src/self-serve.ts and app.ts): whether sign-up is open, the email code with
// its checks, and account.signUp. What the page reads from its address: the plan and the interval, nothing else.
import { SIGNUP_COUNTRIES } from '@linedesk/db/types'
import { i18n } from './i18n/index.tsx'

export { SIGNUP_COUNTRIES }

/** The plan's prices and the trial at the install's rules (Server admin › Billing), in cents before tax. */
export type SignupPlan = { monthlyCents: number; yearlyCents: number; trialDays: number }
/** The partner plan (docs/white-label.md): its base fee, and in the free trial at most `trialClients` client workspaces. */
export type PartnerSignupPlan = SignupPlan & { trialClients: number }
export type SignupConfig = {
  open: boolean
  turnstileSiteKey: string | null
  plan: SignupPlan | null
  partnerPlan: PartnerSignupPlan | null
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
    }
    return {
      open: body.open === true,
      turnstileSiteKey: body.turnstileSiteKey ?? null,
      plan: readPlan(body.plan),
      partnerPlan: readPartnerPlan(body.partnerPlan),
    }
  } catch {
    return 'unreachable'
  }
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

/**
 * The plan's price at an interval in words: "$108 per workspace, billed yearly ($9 a month)", "$11 per workspace,
 * billed monthly". Whole dollars without cents.
 */
export function planWords(interval: 'year' | 'month', cents: number): string {
  const { t, format } = i18n()
  const usd = (c: number) => format.currency(c / 100, 'USD', { minimumFractionDigits: c % 100 ? 2 : 0 })
  return interval === 'year'
    ? t('auth.plan.yearly', { price: usd(cents), monthly: usd(Math.round(cents / 12)) })
    : t('auth.plan.monthly', { price: usd(cents) })
}

/**
 * The partner plan's base fee in words: "$168 a year for the partner account ($14 a month), plus each client
 * workspace at the workspace price", "$19 a month for the partner account, plus …".
 */
export function partnerPlanWords(interval: 'year' | 'month', cents: number): string {
  const { t, format } = i18n()
  const usd = (c: number) => format.currency(c / 100, 'USD', { minimumFractionDigits: c % 100 ? 2 : 0 })
  return interval === 'year'
    ? t('auth.plan.partnerYearly', { price: usd(cents), monthly: usd(Math.round(cents / 12)) })
    : t('auth.plan.partnerMonthly', { price: usd(cents) })
}

/** The sign-up page's line about the plan picked in the address: the trial, then the price at that interval. */
export function signupPlanLine(plan: SignupPlan, interval: 'year' | 'month', partner = false): string {
  const { t } = i18n()
  const cents = interval === 'year' ? plan.yearlyCents : plan.monthlyCents
  const words = partner ? partnerPlanWords(interval, cents) : planWords(interval, cents)
  return plan.trialDays > 0
    ? t('auth.signup.plan', { days: plan.trialDays, plan: words })
    : t('auth.signup.planNoTrial', { plan: words })
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
  plan: 'cloud' | 'partner'
  interval: 'year' | 'month'
  timeZone?: string
}

/**
 * account.signUp through POST /v1/signup: the bill and the workspace (or, plan `partner`, the partner), waiting for
 * Checkout. `partnerOwned`: this account owns a partner already.
 */
export async function signUpBusiness(
  input: SignUpInput,
): Promise<
  | { ok: true; workspaceId: string | null; partnerId: string | null }
  | { ok: false; notYet: boolean; closed: boolean; partnerOwned?: boolean }
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
    if (body?.code === 'already_partner') return { ok: false, notYet: false, closed: false, partnerOwned: true }
    // 409: the country is not served yet; 403: closed meanwhile.
    return { ok: false, notYet: res.status === 409 && !body?.code, closed: res.status === 403 }
  } catch {
    return { ok: false, notYet: false, closed: false }
  }
}
