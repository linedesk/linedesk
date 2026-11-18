// Self-serve sign-up on Linedesk Cloud (src/self-serve.ts, src/signup-handlers.ts, docs/billing.md §3.1, §3.2; PR 7):
// closed unless billing is in effect and `signup.selfServe` is on; the checks before a code goes out (disposable
// domains, Turnstile, the per-address, per-IP and install limits with the admin alert); the account made only after a
// code asked for on the sign-up page; account.signUp making the bill and its one pending_payment workspace (once per
// account, US/CA/PR only); what pending_payment refuses; the daily sweep.
// Billing is switched on by replacing billingState (no Stripe keys in tests). Instance-wide: it sets instance
// settings and the Turnstile keys.
// The app first (as the server loads it): the handler registry before the modules it collects.
import {
  act,
  anonymous,
  appRequest,
  asServerAdmin,
  createWorkspace,
  FROM,
  randomIp,
  request,
  signUp,
} from './helpers.ts'
import {
  agent_setup_keys,
  billing_accounts,
  billing_balances,
  commands,
  instance_settings,
  member,
  organization,
  partner_members,
  partners,
  signup_attempts,
  terms_acceptances,
  user,
  workspace_settings,
} from '@linedesk/db'
import { and, count, eq, gte } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { WEB_ORIGIN } from '../src/auth.ts'
import { noteAgentSeen } from '../src/admin-overview.ts'
import { setupActorIn, workspaceSetupActor } from '../src/agent-setup.ts'
import { db } from '../src/db.ts'
import { runAction } from '../src/run-action.ts'
import { emailSender } from '../src/email.ts'
import { setJobQueue } from '../src/jobs.ts'
import { setProviderKeys } from '../src/provider-settings.ts'
import {
  emailHash,
  mergeSignupRules,
  PENDING_PAYMENT,
  SELF_SERVE_KEY,
  SIGNUP_RULES_KEY,
  selfServeState,
  setTurnstileFetch,
  TURNSTILE_VERIFY_URL,
} from '../src/self-serve.ts'
import { COUNTRY_NOT_SERVED, sweepSignUps, TERMS_CHANGED } from '../src/signup-handlers.ts'
import { EMAIL_CODE_SIGN_IN_PATH, mayCreateUser, refuseClosedSignUp } from '../src/signup-gate.ts'

const billing = vi.hoisted(() => ({ inEffect: true }))
vi.mock('../src/billing-settings.ts', async original => {
  const real = await original<typeof import('../src/billing-settings.ts')>()
  return {
    ...real,
    billingState: async (...args: Parameters<typeof real.billingState>) => ({
      ...(await real.billingState(...args)),
      ...(billing.inEffect ? { on: true, inEffect: 'stripe' as const } : { inEffect: 'none' as const }),
    }),
  }
})

const ORIGIN = { origin: 'http://localhost:5173' }
/** mayCreateUser as the sign-up page's own requests ask it (entering the code, sending it from the page). */
const SELF_SERVE = { selfServe: true }
const address = (prefix: string, domain = 'linedesk.test') => `${prefix}-${crypto.randomUUID().slice(0, 8)}@${domain}`
const HOUR = 3_600_000
const DAY = 24 * HOUR

async function setting(key: string, value: string | null) {
  if (value === null) return db.delete(instance_settings).where(eq(instance_settings.key, key))
  const now = new Date().toISOString()
  await db
    .insert(instance_settings)
    .values({ key, value, updated_at: now })
    .onConflictDoUpdate({ target: instance_settings.key, set: { value, updated_at: now } })
}
const rules = (r: Record<string, unknown>) => setting(SIGNUP_RULES_KEY, JSON.stringify(r))

/** The jobs queued in a transaction (a fake queue: nothing runs). */
let queued: { name: string; data: Record<string, unknown> }[] = []
/** The install's terms and privacy policy (A9): self-serve sign-up stays closed without them. */
const TERMS = {
  TERMS_URL: 'https://desk.example.com/terms',
  TERMS_VERSION: '2026-11-17',
  PRIVACY_URL: 'https://desk.example.com/privacy',
  PRIVACY_VERSION: '2026-11-10',
}
beforeEach(async () => {
  for (const [name, value] of Object.entries(TERMS)) vi.stubEnv(name, value)
  billing.inEffect = true
  await setting(SELF_SERVE_KEY, 'on')
  // The bot check has its own tests below; the rest run without it.
  await rules({ turnstile: false })
  queued = []
  setJobQueue({
    send: async (name: string, data: Record<string, unknown>) => {
      queued.push({ name, data })
      return 'job'
    },
    insert: async () => [],
  } as never)
})
afterEach(() => {
  vi.unstubAllEnvs()
  setJobQueue(null)
  setTurnstileFetch(null)
})

/** POST /v1/signup/code from `ip`; the code from the email when one went out, else null. */
async function askCode(email: string, ip = randomIp(), token = '') {
  const send = vi.spyOn(emailSender, 'send').mockResolvedValue(undefined)
  try {
    const res = await request(anonymous, 'POST', '/v1/signup/code', { email, token }, { ...ORIGIN, [FROM]: ip })
    // The code email is sent without waiting (no account enumeration by timing): when the request was admitted, wait
    // for it; a refused one never sends, give it a moment to show that.
    const sent = () => send.mock.calls.map(([m]) => m).findLast(m => m.to === email)
    if (res.status === 200) await vi.waitFor(() => expect(sent()).toBeDefined(), { timeout: 5000, interval: 20 })
    else await new Promise(r => setTimeout(r, 50))
    const mail = sent()
    return { ...res, code: mail ? mail.subject.slice(0, 6) : null }
  } finally {
    send.mockRestore()
  }
}

/** Enters the code: signs in (and makes the account when the gate allows). The session's cookies. */
async function enterCode(email: string, otp: string) {
  const res = await appRequest('/api/auth/sign-in/email-otp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...ORIGIN, [FROM]: randomIp() },
    body: JSON.stringify({ email, otp }),
  })
  const cookie = res.headers
    .getSetCookie()
    .map(c => c.split(';')[0])
    .join('; ')
  return { status: res.status, body: await res.text(), who: { headers: { cookie, ...ORIGIN } } }
}

const DETAILS = {
  name: 'Mike Brennan',
  businessName: 'Brightwater Plumbing & Heating',
  country: 'US',
  plan: 'cloud',
  interval: 'year',
  acceptedTerms: { termsVersion: TERMS.TERMS_VERSION, privacyVersion: TERMS.PRIVACY_VERSION },
}

/** The whole page: a code, signed in, account.signUp. */
async function signUpThroughPage(
  email = address('owner'),
  details: Record<string, unknown> = DETAILS,
  headers: Record<string, string> = {},
) {
  const { code } = await askCode(email)
  expect(code).toMatch(/^\d{6}$/)
  const { status, who, body } = await enterCode(email, code!)
  expect(status, body).toBe(200)
  const made = await request(who, 'POST', '/v1/signup', details, headers)
  return { email, who, made }
}

/** What the sign-up page sends now: the person's name only (docs/billing.md §3.2). */
const NAME_ONLY = {
  name: 'Mike Brennan',
  plan: 'cloud',
  interval: 'year',
  acceptedTerms: { termsVersion: TERMS.TERMS_VERSION, privacyVersion: TERMS.PRIVACY_VERSION },
}
/** The visitor's country as the proxy in front names it (country-hint.ts). */
const FROM_COUNTRY = (code: string) => ({ 'x-linedesk-country': code })

const accountOf = async (email: string) => (await db.select().from(user).where(eq(user.email, email)))[0]

describe('closed unless switched on and billing is in effect', () => {
  test('switched off: the page says closed, no code goes out, no account is made', async () => {
    await setting(SELF_SERVE_KEY, null)
    const config = await request(anonymous, 'GET', '/v1/signup/config')
    expect(config.body).toMatchObject({ ok: true, open: false, turnstileSiteKey: null, plan: null })
    const email = address('closed')
    const asked = await askCode(email)
    expect(asked).toMatchObject({ status: 404, body: { ok: false, code: 'closed' }, code: null })
    expect(await mayCreateUser(db, email, true, SELF_SERVE)).toBe(false)
  })

  test('on, but billing not in effect (every self-hosted install): closed', async () => {
    billing.inEffect = false
    expect((await request(anonymous, 'GET', '/v1/signup/config')).body.open).toBe(false)
    expect(await askCode(address('nobilling'))).toMatchObject({ status: 404, code: null })
  })

  test("open: the config names the sign-up countries, the plan at the install's prices and the terms to show", async () => {
    expect((await request(anonymous, 'GET', '/v1/signup/config')).body).toMatchObject({
      open: true,
      countries: ['US', 'CA', 'PR'],
      // The sign-up page shows the price and the trial (billing tour, G3), from the rules, not written into the page.
      plan: { monthlyCents: 1100, yearlyCents: 10_800, trialDays: 14 },
      // The partner plan (docs/white-label.md): its base fee, and no free trial (Janik, 2026-11-18).
      partnerPlan: { monthlyCents: 1900, yearlyCents: 16_800 },
      terms: {
        termsUrl: TERMS.TERMS_URL,
        termsVersion: TERMS.TERMS_VERSION,
        privacyUrl: TERMS.PRIVACY_URL,
        privacyVersion: TERMS.PRIVACY_VERSION,
      },
    })
    expect((await request(anonymous, 'GET', '/v1/signup/config')).body.partnerPlan).toEqual({
      monthlyCents: 1900,
      yearlyCents: 16_800,
    })
  })

  test('a stored partner trial limit from before 2026-11-18 is ignored without a problem; the Cloud trial limit stays', () => {
    expect(mergeSignupRules({ trialWorkspacesPartner: 2, trialWorkspacesCloud: 3 })).toEqual({
      rules: expect.objectContaining({ trialWorkspacesCloud: 3 }),
      problems: [],
    })
    expect(mergeSignupRules({}).rules).not.toHaveProperty('trialWorkspacesPartner')
  })

  test('switched on but a terms link or version missing: closed, fail closed (A9)', async () => {
    for (const name of Object.keys(TERMS)) {
      vi.stubEnv(name, '')
      expect(await db.transaction(tx => selfServeState(tx))).toMatchObject({
        on: true,
        open: false,
        closedBecause: 'terms_missing',
      })
      expect((await request(anonymous, 'GET', '/v1/signup/config')).body).toMatchObject({ open: false, terms: null })
      expect(await askCode(address('noterms'))).toMatchObject({ status: 404, code: null })
      vi.stubEnv(name, TERMS[name as keyof typeof TERMS])
    }
    // A version that is not a short label counts as missing.
    vi.stubEnv('TERMS_VERSION', 'see the website')
    expect((await db.transaction(tx => selfServeState(tx))).closedBecause).toBe('terms_missing')
  })

  test('the normal sign-in page still sends no code to an unknown address while sign-up is open', async () => {
    const email = address('login')
    const send = vi.spyOn(emailSender, 'send').mockResolvedValue(undefined)
    try {
      const res = await request(
        anonymous,
        'POST',
        '/api/auth/email-otp/send-verification-otp',
        { email, type: 'sign-in' },
        { ...ORIGIN, [FROM]: randomIp() },
      )
      expect(res.status).toBe(200)
      await new Promise(r => setTimeout(r, 50))
      expect(send.mock.calls.some(([m]) => m.to === email)).toBe(false)
    } finally {
      send.mockRestore()
    }
    expect(await mayCreateUser(db, email, true, SELF_SERVE)).toBe(false)
  })

  test('after a sign-up code, the normal sign-in page still sends that new address nothing (security review F4)', async () => {
    const email = address('window')
    expect((await askCode(email)).code).not.toBeNull()
    const send = vi.spyOn(emailSender, 'send').mockResolvedValue(undefined)
    try {
      for (let i = 0; i < 3; i++) {
        const res = await request(
          anonymous,
          'POST',
          '/api/auth/email-otp/send-verification-otp',
          { email, type: 'sign-in' },
          { ...ORIGIN, [FROM]: randomIp() },
        )
        expect(res.status).toBe(200)
      }
      await new Promise(r => setTimeout(r, 50))
      expect(send.mock.calls.some(([m]) => m.to === email)).toBe(false)
    } finally {
      send.mockRestore()
    }
    // Account creation outside the email-code sign-in (a provider sign-in) is refused in the window too.
    expect(await mayCreateUser(db, email, true)).toBe(false)
    await expect(refuseClosedSignUp(db, { email, emailVerified: true }, '/callback/google')).rejects.toMatchObject({
      body: { code: 'SIGNUP_CLOSED' },
    })
    await expect(
      refuseClosedSignUp(db, { email, emailVerified: true }, EMAIL_CODE_SIGN_IN_PATH),
    ).resolves.toBeUndefined()
  })

  test('a code asked for on the sign-up page lets only a proven address in, and only while open', async () => {
    const email = address('gate')
    expect((await askCode(email)).code).not.toBeNull()
    expect(await mayCreateUser(db, email, false, SELF_SERVE)).toBe(false)
    expect(await mayCreateUser(db, email, true, SELF_SERVE)).toBe(true)
    await setting(SELF_SERVE_KEY, 'off')
    expect(await mayCreateUser(db, email, true, SELF_SERVE)).toBe(false)
  })
})

describe('the sign-in page: whether sign-up is open (GET /v1/auth-methods)', () => {
  const flag = async () => {
    const body = (await request(anonymous, 'GET', '/v1/auth-methods')).body
    // Only the yes or no: never why it is closed, nor the rules, the plan or the bot check's key.
    expect(body).not.toHaveProperty('closedBecause')
    expect(body).not.toHaveProperty('rules')
    expect(JSON.stringify(body)).not.toMatch(/turnstile|switched_off|billing_not_in_effect|terms_missing|bot_check/i)
    return body.selfServeSignup
  }

  test('true while open: the sign-in page links to the sign-up page', async () => {
    expect(await flag()).toBe(true)
  })

  test('false whenever the sign-up steps would refuse: switched off, billing not in effect, terms or bot check missing', async () => {
    await setting(SELF_SERVE_KEY, null)
    expect(await flag()).toBe(false)
    await setting(SELF_SERVE_KEY, 'on')
    billing.inEffect = false
    expect(await flag()).toBe(false)
    billing.inEffect = true
    vi.stubEnv('TERMS_URL', '')
    expect(await flag()).toBe(false)
    vi.stubEnv('TERMS_URL', TERMS.TERMS_URL)
    // The rules ask for Turnstile and no keys are set.
    await rules({ turnstile: true })
    expect(await flag()).toBe(false)
    await rules({ turnstile: false })
    expect(await flag()).toBe(true)
  })
})

describe("the sign-up code email's button, in any browser", () => {
  /** POST /v1/signup/code with a plan; the email's code and its button's address. */
  async function askWithPlan(email: string, extra: Record<string, unknown>) {
    const send = vi.spyOn(emailSender, 'send').mockResolvedValue(undefined)
    try {
      const res = await request(
        anonymous,
        'POST',
        '/v1/signup/code',
        { email, token: '', ...extra },
        { ...ORIGIN, [FROM]: randomIp() },
      )
      expect(res.status).toBe(200)
      await vi.waitFor(() => expect(send.mock.calls.some(([m]) => m.to === email)).toBe(true), { timeout: 5000 })
      const mail = send.mock.calls.map(([m]) => m).findLast(m => m.to === email)!
      const url = /(https?:\/\/\S+#sign-in=[A-Za-z0-9_-]{43})/.exec(mail.text)?.[1]
      expect(url).toBeTruthy()
      return { code: mail.subject.slice(0, 6), url: new URL(url!), text: mail.text }
    } finally {
      send.mockRestore()
    }
  }
  const link = (step: 'check' | 'use', token: string) =>
    request(anonymous, 'POST', `/v1/sign-in-link/${step}`, { token }, { ...ORIGIN, [FROM]: randomIp() })

  test('the button opens the sign-up page with its plan; the email no longer says it works only in one browser', async () => {
    const partner = await askWithPlan(address('plan'), { plan: 'partner', interval: 'month' })
    expect(partner.url.pathname + partner.url.search).toBe('/signup?plan=partner&interval=month')
    expect(partner.text).not.toMatch(/browser where you asked/i)
    const plain = await askWithPlan(address('plain'), {})
    expect(plain.url.pathname + plain.url.search).toBe('/signup')
    // Only known values travel: anything else is the default plan.
    const odd = await askWithPlan(address('odd'), { plan: 'https://evil.example', interval: '<x>' })
    expect(odd.url.pathname + odd.url.search).toBe('/signup')
  })

  test('opened in another browser: opening signs nobody in; Continue makes the account there and the details step goes on', async () => {
    const email = address('otherbrowser')
    const { url, code } = await askWithPlan(email, { plan: 'cloud', interval: 'year' })
    const token = url.hash.slice('#sign-in='.length)
    // What a mail scanner does: load the page. Nothing to GET, nobody signed in, no account made.
    expect((await appRequest('/v1/sign-in-link/check', { headers: ORIGIN })).status).not.toBe(200)
    expect(await accountOf(email)).toBeUndefined()
    // The other browser (no cookies from the sign-up page): the confirm page, then Continue.
    expect((await link('check', token)).body).toEqual({ ok: true, state: 'ready', email })
    expect(await accountOf(email)).toBeUndefined()
    const used = await appRequest('/v1/sign-in-link/use', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...ORIGIN, [FROM]: randomIp() },
      body: JSON.stringify({ token }),
    })
    expect(used.status).toBe(200)
    const cookie = used.headers
      .getSetCookie()
      .map(c => c.split(';')[0])
      .join('; ')
    expect(await accountOf(email)).toMatchObject({ emailVerified: true })
    // The sign-up goes on in this browser: the details step with the terms, as in the browser that asked.
    const who = { headers: { cookie, ...ORIGIN } }
    expect((await request(who, 'POST', '/v1/signup', { ...DETAILS, acceptedTerms: undefined })).status).toBe(422)
    const made = await request(who, 'POST', '/v1/signup', DETAILS)
    expect(made.status, JSON.stringify(made.body)).toBe(200)
    // Used up: the link again, and the code in the browser that asked for it, sign nobody in.
    expect((await link('check', token)).body).toEqual({ ok: true, state: 'spent' })
    expect((await link('use', token)).status).toBe(400)
    expect((await enterCode(email, code)).status).not.toBe(200)
  })

  test('closed meanwhile: Continue in another browser makes no account (the sign-up gate still decides)', async () => {
    const email = address('closedlink')
    const { url } = await askWithPlan(email, {})
    await setting(SELF_SERVE_KEY, null)
    const used = await link('use', url.hash.slice('#sign-in='.length))
    expect(used.status).toBe(403)
    expect(used.body).toMatchObject({ ok: false, code: 'SIGNUP_CLOSED' })
    expect(await accountOf(email)).toBeUndefined()
  })
})

describe('account.signUp', () => {
  test('makes the bill and its one workspace, waiting for Checkout, with the person as owner', async () => {
    const { email, who, made } = await signUpThroughPage()
    expect(made).toMatchObject({ status: 200, body: { ok: true, data: { existing: false } } })
    const { billId, workspace } = made.body.data
    const [bill] = await db.select().from(billing_accounts).where(eq(billing_accounts.id, billId))
    const account = await accountOf(email)
    expect(bill).toMatchObject({
      kind: 'cloud',
      status: 'pending_payment',
      interval: 'year',
      owner_user_id: account!.id,
    })
    const [org] = await db.select().from(organization).where(eq(organization.id, workspace.id))
    expect(org).toMatchObject({ name: DETAILS.businessName, billingAccountId: billId, billingState: 'pending_payment' })
    expect(account).toMatchObject({ name: 'Mike Brennan', emailVerified: true })
    const [owner] = await db
      .select()
      .from(member)
      .where(and(eq(member.organizationId, workspace.id), eq(member.userId, account!.id)))
    expect(owner?.role).toBe('owner')
    // The app opens on it: /v1/me has the workspace and its billing state.
    const me = await request(who, 'GET', '/v1/me')
    expect(me.body.workspace).toMatchObject({ id: workspace.id, billingState: 'pending_payment' })
    // Logged for the audit log, under the new workspace.
    const [logged] = await db
      .select()
      .from(commands)
      .where(and(eq(commands.action, 'account.signUp'), eq(commands.actor_id, account!.id)))
    expect(logged?.result).toMatchObject({ data: { subject: { workspaceId: workspace.id } } })
    // The acceptance of the terms and privacy policy (A9): who, which bill, which texts, when, from where.
    const accepted = await db.select().from(terms_acceptances).where(eq(terms_acceptances.user_id, account!.id))
    expect(accepted).toHaveLength(1)
    expect(accepted[0]).toMatchObject({
      billing_account_id: billId,
      source: 'signup',
      terms_url: TERMS.TERMS_URL,
      terms_version: TERMS.TERMS_VERSION,
      privacy_url: TERMS.PRIVACY_URL,
      privacy_version: TERMS.PRIVACY_VERSION,
    })
    expect(accepted[0]!.ip_address).toMatch(/\d/)
    expect(Date.now() - Date.parse(accepted[0]!.accepted_at)).toBeLessThan(60_000)
  })

  test('terms changed while the page was open: refused with terms_changed, nothing is made or recorded', async () => {
    const stale = { ...DETAILS, acceptedTerms: { termsVersion: '2026-01-01', privacyVersion: TERMS.PRIVACY_VERSION } }
    const { email, made } = await signUpThroughPage(address('stale'), stale)
    expect(made).toMatchObject({ status: 409, body: { ok: false, code: TERMS_CHANGED } })
    const account = await accountOf(email)
    expect(await db.select().from(billing_accounts).where(eq(billing_accounts.owner_user_id, account!.id))).toEqual([])
    expect(await db.select().from(terms_acceptances).where(eq(terms_acceptances.user_id, account!.id))).toEqual([])
  })

  test('a partner sign-up: stale terms are refused, and without terms in the environment it is closed (A9)', async () => {
    const PARTNER = { ...DETAILS, businessName: 'Stale Agency', plan: 'partner' }
    const stale = { ...PARTNER, acceptedTerms: { termsVersion: TERMS.TERMS_VERSION, privacyVersion: '2026-01-01' } }
    const { email, who, made } = await signUpThroughPage(address('stalepartner'), stale)
    expect(made).toMatchObject({ status: 409, body: { ok: false, code: TERMS_CHANGED } })
    const account = await accountOf(email)
    vi.stubEnv('PRIVACY_URL', '')
    expect((await request(who, 'POST', '/v1/signup', PARTNER)).status).toBe(403)
    vi.stubEnv('PRIVACY_URL', TERMS.PRIVACY_URL)
    expect(await db.select().from(billing_accounts).where(eq(billing_accounts.owner_user_id, account!.id))).toEqual([])
    expect(await db.select().from(partner_members).where(eq(partner_members.user_id, account!.id))).toEqual([])
    expect(await db.select().from(terms_acceptances).where(eq(terms_acceptances.user_id, account!.id))).toEqual([])
  })

  test('without the accepted terms: refused as input', async () => {
    const { acceptedTerms: _, ...without } = DETAILS
    const { made } = await signUpThroughPage(address('noaccept'), without)
    expect(made.status).toBe(422)
  })

  test('one waiting sign-up per account: asked again, it answers the one there is', async () => {
    const { who, made } = await signUpThroughPage()
    const again = await request(who, 'POST', '/v1/signup', { ...DETAILS, businessName: 'Second Business' })
    expect(again.body).toMatchObject({ ok: true, data: { billId: made.body.data.billId, existing: true } })
    expect(again.body.data.workspace.id).toBe(made.body.data.workspace.id)
  })

  test('outside the US, Canada and Puerto Rico: not yet, nothing is made', async () => {
    const { email, made } = await signUpThroughPage(address('abroad'), { ...DETAILS, country: 'de' })
    expect(made).toMatchObject({ status: 409, body: { ok: false, code: COUNTRY_NOT_SERVED } })
    const account = await accountOf(email)
    expect(await db.select().from(billing_accounts).where(eq(billing_accounts.owner_user_id, account!.id))).toEqual([])
  })

  test('name only: a placeholder name, the country Automatic on where the request comes from', async () => {
    const { who, made } = await signUpThroughPage(address('nameonly'), NAME_ONLY, FROM_COUNTRY('US'))
    expect(made).toMatchObject({ status: 200, body: { ok: true, data: { existing: false } } })
    const { workspace } = made.body.data
    expect(workspace.name).toBe('My business')
    const [settings] = await db
      .select()
      .from(workspace_settings)
      .where(eq(workspace_settings.workspace_id, workspace.id))
    expect(settings).toMatchObject({ country: null, country_hint: 'US', country_hint_source: 'sign_up_location' })
    // The Business step asks for the name instead of prefilling the placeholder.
    expect((await request(who, 'GET', '/v1/me')).body.workspace).toMatchObject({ id: workspace.id, unnamed: true })
  })

  test('name only, from a country not served yet: not yet, nothing is made', async () => {
    const { email, made } = await signUpThroughPage(address('fromde'), NAME_ONLY, FROM_COUNTRY('DE'))
    expect(made).toMatchObject({ status: 409, body: { ok: false, code: COUNTRY_NOT_SERVED } })
    const account = await accountOf(email)
    expect(await db.select().from(billing_accounts).where(eq(billing_accounts.owner_user_id, account!.id))).toEqual([])
  })

  test("the hint is the request's own: one the caller sends is replaced", async () => {
    const sent = { ...NAME_ONLY, countryHint: { country: 'US', source: 'sign_up_location' } }
    const { made } = await signUpThroughPage(address('claims'), sent, FROM_COUNTRY('DE'))
    expect(made).toMatchObject({ status: 409, body: { code: COUNTRY_NOT_SERVED } })
    // Without a location, the time zone the page sent decides.
    const zoned = await signUpThroughPage(address('zoned'), { ...NAME_ONLY, timeZone: 'Europe/Berlin' })
    expect(zoned.made).toMatchObject({ status: 409, body: { code: COUNTRY_NOT_SERVED } })
    const chicago = await signUpThroughPage(address('chicago'), { ...NAME_ONLY, timeZone: 'America/Chicago' })
    expect(chicago.made.status).toBe(200)
  })

  test('name only, from nowhere known: made, the Business step decides on the country', async () => {
    const { made } = await signUpThroughPage(address('nowhere'), NAME_ONLY)
    expect(made.status, JSON.stringify(made.body)).toBe(200)
    const [settings] = await db
      .select()
      .from(workspace_settings)
      .where(eq(workspace_settings.workspace_id, made.body.data.workspace.id))
    expect(settings).toMatchObject({ country: null, country_hint: null })
  })

  test('a country picked on an older page still decides over the hint', async () => {
    const { made } = await signUpThroughPage(address('older'), DETAILS, FROM_COUNTRY('DE'))
    expect(made.status).toBe(200)
    const [org] = await db.select().from(organization).where(eq(organization.id, made.body.data.workspace.id))
    expect(org?.name).toBe(DETAILS.businessName)
  })

  test("plan partner: the company's name is required, the country comes from the request", async () => {
    const PARTNER = { ...NAME_ONLY, plan: 'partner' }
    expect((await signUpThroughPage(address('nopartnername'), PARTNER, FROM_COUNTRY('US'))).made.status).toBe(422)
    const abroad = await signUpThroughPage(
      address('partnerde'),
      { ...PARTNER, businessName: 'Agentur' },
      FROM_COUNTRY('DE'),
    )
    expect(abroad.made).toMatchObject({ status: 409, body: { code: COUNTRY_NOT_SERVED } })
    const named = { ...PARTNER, businessName: 'Cascade IT Partners' }
    const { made } = await signUpThroughPage(address('partnername'), named, FROM_COUNTRY('CA'))
    expect(made).toMatchObject({ status: 200, body: { data: { partner: { name: 'Cascade IT Partners' } } } })
  })

  test('plan partner: the partner waiting for approval, its owner, the partner bill waiting for Checkout, no workspace', async () => {
    const PARTNER = { ...DETAILS, businessName: 'Cascade IT Partners', plan: 'partner', interval: 'month' }
    const { email, who, made } = await signUpThroughPage(address('partner'), PARTNER)
    expect(made).toMatchObject({ status: 200, body: { ok: true, data: { workspace: null, existing: false } } })
    const { billId, partner } = made.body.data
    const account = await accountOf(email)
    expect((await db.select().from(billing_accounts).where(eq(billing_accounts.id, billId)))[0]).toMatchObject({
      kind: 'partner',
      status: 'pending_payment',
      interval: 'month',
      owner_user_id: account!.id,
    })
    expect((await db.select().from(partners).where(eq(partners.id, partner.id)))[0]).toMatchObject({
      name: 'Cascade IT Partners',
      status: 'pending',
      billing_account_id: billId,
      created_by: account!.id,
    })
    expect(await db.select().from(partner_members).where(eq(partner_members.partner_id, partner.id))).toMatchObject([
      { user_id: account!.id, role: 'owner' },
    ])
    expect(await db.select().from(member).where(eq(member.userId, account!.id))).toEqual([])
    // The partner accepted the terms and the privacy policy too (A9), on its partner bill.
    expect(await db.select().from(terms_acceptances).where(eq(terms_acceptances.user_id, account!.id))).toMatchObject([
      {
        billing_account_id: billId,
        source: 'signup',
        terms_version: TERMS.TERMS_VERSION,
        privacy_version: TERMS.PRIVACY_VERSION,
      },
    ])
    // The app opens the partner area: /v1/me lists the partner.
    expect((await request(who, 'GET', '/v1/me')).body.partners).toMatchObject([{ id: partner.id, role: 'owner' }])
    // The instance admins hear of it, in the sign-up's own transaction (sent once it is committed).
    const told = () => queued.filter(j => j.name === 'billing.alert' && j.data.kind === 'partner_signup')
    expect(told()).toEqual([{ name: 'billing.alert', data: { kind: 'partner_signup', partner: partner.id } }])
    // Asked again: the one waiting sign-up, not a second partner, and no second alert.
    const again = await request(who, 'POST', '/v1/signup', { ...PARTNER, businessName: 'Second Agency' })
    expect(again.body).toMatchObject({ ok: true, data: { billId, partner: { id: partner.id }, existing: true } })
    expect(told()).toHaveLength(1)
    // Once that bill runs, a second partner for the same owner is refused.
    await db.update(billing_accounts).set({ status: 'trialing' }).where(eq(billing_accounts.id, billId))
    expect(await request(who, 'POST', '/v1/signup', PARTNER)).toMatchObject({
      status: 409,
      body: { code: 'already_partner' },
    })
  })

  test('only a signed-in person: no session, and an API key, are 401', async () => {
    expect((await request(anonymous, 'POST', '/v1/signup', DETAILS)).status).toBe(401)
    // An API key is not a session.
    expect(
      (await request({ headers: { authorization: 'Bearer ldk_not_a_session' } }, 'POST', '/v1/signup', DETAILS)).status,
    ).toBe(401)
  })

  test('closed meanwhile: a signed-in person cannot sign up', async () => {
    const email = address('late')
    const { code } = await askCode(email)
    const { who } = await enterCode(email, code!)
    await setting(SELF_SERVE_KEY, 'off')
    expect((await request(who, 'POST', '/v1/signup', DETAILS)).status).toBe(403)
  })

  test('the permission `account` is given only by the sign-up route: the action endpoint refuses it', async () => {
    const someone = (await createWorkspace('Member Elsewhere')).owner
    expect(await act(someone, 'account.signUp', DETAILS)).toMatchObject({
      status: 403,
      body: { error: 'missing permission account:signUp' },
    })
  })
})

describe('one free trial per account, and New workspace from the app (decision of 2026-11-17)', () => {
  /** The account's sign-up started its trial (as a confirmed Checkout leaves it). */
  const trialStarted = (billId: string) =>
    db
      .update(billing_accounts)
      .set({
        status: 'trialing',
        checkout_confirmed_at: new Date().toISOString(),
        trial_ends_at: '2026-12-01T00:00:00Z',
      })
      .where(eq(billing_accounts.id, billId))
  const billOf = async (id: string) => (await db.select().from(billing_accounts).where(eq(billing_accounts.id, id)))[0]!

  test('a first account gets the trial: nothing refused, the page and the activation step promise it', async () => {
    const { who, made } = await signUpThroughPage(address('first'))
    expect(await billOf(made.body.data.billId)).toMatchObject({ trial_refused: null })
    expect((await request(who, 'GET', '/v1/signup/config')).body.trial).toBe(true)
    const me = (await request(who, 'GET', '/v1/me')).body
    expect(me.workspace).toMatchObject({ trialDays: 14, activation: { trialDays: 14 } })
    // Its one workspace waits for Checkout: the menu offers to finish that one, never a second sign-up.
    expect(me.newWorkspace).toEqual({ trial: true, interval: 'year', waiting: made.body.data.workspace })
    // Signed out, the page promises the trial as before.
    expect((await request(anonymous, 'GET', '/v1/signup/config')).body.trial).toBe(true)
  })

  test('a second workspace of the same account: its own bill, no trial, said before the card', async () => {
    const { email, who, made } = await signUpThroughPage(address('second'))
    const first = made.body.data
    await trialStarted(first.billId)
    // The menu offers a new workspace, with the plan starting today; the sign-up page says the same.
    expect((await request(who, 'GET', '/v1/me')).body.newWorkspace).toEqual({
      trial: false,
      interval: 'year',
      waiting: null,
    })
    expect((await request(who, 'GET', '/v1/signup/config')).body.trial).toBe(false)
    const again = await request(who, 'POST', '/v1/signup', { ...DETAILS, businessName: 'Brightwater Drains' })
    expect(again).toMatchObject({ status: 200, body: { ok: true, data: { existing: false } } })
    const second = again.body.data
    expect(second.billId).not.toBe(first.billId)
    expect(await billOf(second.billId)).toMatchObject({
      kind: 'cloud',
      status: 'pending_payment',
      owner_user_id: (await accountOf(email))!.id,
      trial_refused: 'account_used',
    })
    // The first bill is untouched: each workspace keeps its own bill.
    expect(await billOf(first.billId)).toMatchObject({ status: 'trialing', trial_refused: null })
    // The app opens the new workspace; its activation step sells the plan from today, no trial anywhere.
    const me = (await request(who, 'GET', '/v1/me')).body
    expect(me.workspace).toMatchObject({ id: second.workspace.id, billingState: 'pending_payment', trialDays: null })
    expect(me.workspace.activation).toMatchObject({ trialDays: null, firstChargeAt: null, reminderDays: [] })
    // Now it waits for Checkout: the menu finishes it, and a third sign-up answers the waiting one.
    expect(me.newWorkspace).toMatchObject({ trial: false, waiting: { id: second.workspace.id } })
    const third = await request(who, 'POST', '/v1/signup', { ...DETAILS, businessName: 'Brightwater Third' })
    expect(third.body).toMatchObject({ ok: true, data: { billId: second.billId, existing: true } })
  })

  test('a paid plan without a trial counts too; a sign-up that never reached Checkout does not', async () => {
    const { who, made } = await signUpThroughPage(address('paid'))
    // Still waiting (no Checkout yet): that is not a trial used.
    expect((await request(who, 'GET', '/v1/signup/config')).body.trial).toBe(true)
    await db
      .update(billing_accounts)
      .set({ status: 'active', trial_refused: 'card_used', checkout_confirmed_at: new Date().toISOString() })
      .where(eq(billing_accounts.id, made.body.data.billId))
    expect((await request(who, 'GET', '/v1/signup/config')).body.trial).toBe(false)
  })

  test('not offered to a member who owns no bill, nor on a partner team; the partner sign-up is unchanged', async () => {
    const { who, made } = await signUpThroughPage(address('teamowner'))
    await trialStarted(made.body.data.billId)
    // A member of that workspace (owns no Cloud bill): nothing in the menu.
    const email = address('member')
    const { code } = await askCode(email)
    const joined = await enterCode(email, code!)
    const memberAccount = await accountOf(email)
    await db.insert(member).values({
      id: crypto.randomUUID(),
      organizationId: made.body.data.workspace.id,
      userId: memberAccount!.id,
      role: 'member',
      createdAt: new Date(),
    })
    const asMember = { headers: { ...joined.who.headers, 'x-workspace-id': made.body.data.workspace.id } }
    expect((await request(asMember, 'GET', '/v1/me')).body.newWorkspace).toBeNull()
    // The owner signs up as a partner too: the partner bill keeps its trial (the rule is Cloud's), and once on a
    // partner team the menu no longer offers a workspace of their own (clients are made in the partner area).
    const partner = await request(who, 'POST', '/v1/signup', {
      ...DETAILS,
      businessName: 'Brightwater Partners',
      plan: 'partner',
    })
    expect(partner.status).toBe(200)
    expect(await billOf(partner.body.data.billId)).toMatchObject({ kind: 'partner', trial_refused: null })
    const owner = { headers: { ...who.headers, 'x-workspace-id': made.body.data.workspace.id } }
    expect((await request(owner, 'GET', '/v1/me')).body.newWorkspace).toBeNull()
  })

  test("not in a partner's client workspace, and not while sign-up is closed", async () => {
    const { who, made } = await signUpThroughPage(address('client'))
    await trialStarted(made.body.data.billId)
    const owner = { headers: { ...who.headers, 'x-workspace-id': made.body.data.workspace.id } }
    expect((await request(owner, 'GET', '/v1/me')).body.newWorkspace).toMatchObject({ trial: false })
    await setting(SELF_SERVE_KEY, 'off')
    expect((await request(owner, 'GET', '/v1/me')).body.newWorkspace).toBeNull()
    await setting(SELF_SERVE_KEY, 'on')
    const partnerId = `ptn_${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`
    await db.insert(partners).values({ id: partnerId, name: 'Some Agency', created_by: 'an-instance-admin' })
    await db.update(organization).set({ partnerId }).where(eq(organization.id, made.body.data.workspace.id))
    expect((await request(owner, 'GET', '/v1/me')).body.newWorkspace).toBeNull()
  })
})

describe('before a code goes out', () => {
  test('a disposable domain is refused before anything is sent or counted', async () => {
    for (const domain of ['mailinator.com', 'sub.yopmail.com']) {
      const email = address('throwaway', domain)
      expect(await askCode(email)).toMatchObject({ status: 422, body: { code: 'blocked_domain' }, code: null })
      expect(
        await db
          .select()
          .from(signup_attempts)
          .where(eq(signup_attempts.email_hash, emailHash(email))),
      ).toEqual([])
    }
    // The install's own list too.
    await rules({ turnstile: false, blockedDomains: ['spam.example'] })
    expect((await askCode(address('own', 'spam.example'))).body.code).toBe('blocked_domain')
  })

  test('per address: 3 codes an hour, then too many (the same answer whether it has an account or not)', async () => {
    const email = address('limit')
    for (let i = 0; i < 3; i++) expect((await askCode(email)).status).toBe(200)
    expect(await askCode(email)).toMatchObject({ status: 429, body: { code: 'too_many' }, code: null })
    // An existing account's address is counted alike.
    const known = (
      await db
        .select()
        .from(user)
        .where(eq(user.id, (await signUp()).userId))
    )[0]!.email
    for (let i = 0; i < 3; i++) expect((await askCode(known)).status).toBe(200)
    expect((await askCode(known)).status).toBe(429)
  })

  test('per address: 5 a day', async () => {
    const email = address('daily')
    const old = new Date(Date.now() - 2 * HOUR).toISOString()
    await db.insert(signup_attempts).values(
      [0, 1, 2, 3, 4].map(() => ({
        id: crypto.randomUUID(),
        kind: 'code' as const,
        email_hash: emailHash(email),
        ip_bucket: 'x',
        created_at: old,
      })),
    )
    expect((await askCode(email)).status).toBe(429)
  })

  test('per IP: 3 sign-ups an hour, an IPv6 /64 counted as one', async () => {
    const ip = '2001:db8:1:2::10'
    for (let i = 0; i < 3; i++) expect((await askCode(address('ip'), `2001:db8:1:2::${i + 20}`)).status).toBe(200)
    expect(await askCode(address('ip'), ip)).toMatchObject({ status: 429, body: { code: 'too_many' } })
    // Another /64 is not affected.
    expect((await askCode(address('ip'), '2001:db8:1:3::10')).status).toBe(200)
  })

  test('per IP: 10 a day', async () => {
    const ip = randomIp()
    const old = new Date(Date.now() - 3 * HOUR).toISOString()
    await db.insert(signup_attempts).values(
      Array.from({ length: 10 }, () => ({
        id: crypto.randomUUID(),
        kind: 'code' as const,
        email_hash: 'h',
        ip_bucket: ip,
        created_at: old,
      })),
    )
    expect((await askCode(address('ipday'), ip)).status).toBe(429)
  })

  test("the install's hourly cap refuses more and alerts the instance admins once an hour", async () => {
    const [row] = await db
      .select({ n: count() })
      .from(signup_attempts)
      .where(
        and(
          eq(signup_attempts.kind, 'code'),
          gte(signup_attempts.created_at, new Date(Date.now() - HOUR).toISOString()),
        ),
      )
    const n = row!.n
    await rules({ turnstile: false, codesPerInstallHour: n + 1 })
    expect((await askCode(address('cap'))).status).toBe(200)
    expect(await askCode(address('cap'))).toMatchObject({ status: 429, body: { code: 'busy' }, code: null })
    expect(await askCode(address('cap'))).toMatchObject({ status: 429, body: { code: 'busy' } })
    const alerts = queued.filter(j => j.name === 'billing.alert' && j.data.kind === 'signup_cap')
    expect(alerts).toHaveLength(1)
    expect(alerts[0]!.data).toMatchObject({ cap: n + 1 })
  })
})

describe('before the database', () => {
  test('per IP: at most 10 code requests in 10 minutes, refused or not, before any check (security review F3)', async () => {
    const ip = randomIp()
    for (let i = 0; i < 10; i++)
      expect(
        (
          await request(
            anonymous,
            'POST',
            '/v1/signup/code',
            { email: 'not-an-address', token: '' },
            { ...ORIGIN, [FROM]: ip },
          )
        ).body.code,
      ).toBe('invalid_email')
    const over = await request(
      anonymous,
      'POST',
      '/v1/signup/code',
      { email: address('late'), token: '' },
      { ...ORIGIN, [FROM]: ip },
    )
    expect(over).toMatchObject({ status: 429, body: { code: 'too_many' } })
  })
})

describe('Turnstile', () => {
  test('on by default: closed until the keys are set; then the token is checked with Cloudflare', async () => {
    await setting(SIGNUP_RULES_KEY, null)
    expect((await request(anonymous, 'GET', '/v1/signup/config')).body.open).toBe(false)
    expect(await db.transaction(tx => selfServeState(tx))).toMatchObject({
      on: true,
      open: false,
      closedBecause: 'bot_check_missing',
    })
    await setProviderKeys(
      db,
      'turnstile',
      { site_key: '0x4AAAAAAAtestsitekey', secret_key: '0x4AAAAAAAtestsecret' },
      'test',
      new Date().toISOString(),
    )
    expect((await request(anonymous, 'GET', '/v1/signup/config')).body).toMatchObject({
      open: true,
      turnstileSiteKey: '0x4AAAAAAAtestsitekey',
    })

    const asked: URLSearchParams[] = []
    let success = false
    let action = 'signup'
    let hostname = new URL(WEB_ORIGIN).hostname
    setTurnstileFetch((async (url: string, init: RequestInit) => {
      expect(url).toBe(TURNSTILE_VERIFY_URL)
      asked.push(new URLSearchParams(init.body as URLSearchParams))
      return new Response(JSON.stringify({ success, action, hostname }), { status: 200 })
    }) as typeof fetch)
    expect(await askCode(address('bot'), '10.9.8.7', 'bad-token')).toMatchObject({
      status: 422,
      body: { code: 'bot_check' },
      code: null,
    })
    expect(await askCode(address('bot'), '10.9.8.7', '')).toMatchObject({ status: 422, body: { code: 'bot_check' } })
    success = true
    expect((await askCode(address('bot'), '10.9.8.7', 'good-token')).code).not.toBeNull()
    expect(asked.at(-1)?.get('secret')).toBe('0x4AAAAAAAtestsecret')
    expect(asked.at(-1)?.get('response')).toBe('good-token')
    expect(asked.at(-1)?.get('remoteip')).toBe('10.9.8.7')
    // A token solved for another widget action or on another hostname is refused (security review F2).
    action = 'login'
    expect((await askCode(address('bot'), randomIp(), 'good-token')).body.code).toBe('bot_check')
    action = 'signup'
    hostname = 'evil.example'
    expect((await askCode(address('bot'), randomIp(), 'good-token')).body.code).toBe('bot_check')
    // Cloudflare not answering counts as a failed check.
    setTurnstileFetch((async () => {
      throw new Error('offline')
    }) as typeof fetch)
    expect((await askCode(address('bot'), randomIp(), 'good-token')).body.code).toBe('bot_check')
  })
})

describe('while pending_payment', () => {
  test('no number and no forwarding check before the trial (docs/billing.md §3.2)', async () => {
    const { who, made } = await signUpThroughPage()
    const workspaceId = made.body.data.workspace.id
    const inWs = { headers: { ...who.headers, 'x-workspace-id': workspaceId } }
    for (const [name, input] of [
      ['phoneNumber.setup', { areaCode: '503', purchase: true }],
      ['phoneNumber.checkForwarding', { phoneNumberId: 'pn_x', businessNumber: '+15035550100' }],
    ] as const)
      expect(await act(inWs, name, input)).toMatchObject({
        status: 409,
        body: { ok: false, error: PENDING_PAYMENT },
      })
  })

  test('browser test calls run before the trial, within the setup minutes of signup.rules', async () => {
    vi.stubEnv('LIVEKIT_URL', 'ws://livekit.internal:7880')
    vi.stubEnv('LIVEKIT_API_KEY', 'test-key')
    vi.stubEnv('LIVEKIT_API_SECRET', 'test-secret-test-secret-test-secret')
    vi.stubEnv('OPENAI_REALTIME_API_KEY', 'sk-test-realtime')
    noteAgentSeen()
    const { who, made } = await signUpThroughPage()
    const workspaceId = made.body.data.workspace.id
    const inWs = { headers: { ...who.headers, 'x-workspace-id': workspaceId } }
    const first = await act(inWs, 'assistant.startTestCall', {})
    expect(first.status, JSON.stringify(first.body)).toBe(200)
    // The setup minutes used up (a running call counts up to now): no further test call until the trial starts.
    await rules({ turnstile: false, setupTestMinutes: 0 })
    expect(await act(inWs, 'assistant.startTestCall', {})).toMatchObject({
      status: 409,
      body: {
        ok: false,
        error: expect.stringContaining('test-call minutes for setting up'),
      },
    })
  })

  test('the Business step offers and takes only the sign-up countries; a workspace an admin made keeps every one', async () => {
    const { who, made } = await signUpThroughPage(address('served'), NAME_ONLY, FROM_COUNTRY('US'))
    const inWs = { headers: { ...who.headers, 'x-workspace-id': made.body.data.workspace.id } }
    const settings = await act(inWs, 'workspace.getSettings', {})
    expect(settings.body.data.servedCountries).toEqual(['US', 'CA', 'PR'])
    expect(await act(inWs, 'workspace.updateSettings', { country: 'DE' })).toMatchObject({
      status: 409,
      body: { ok: false, code: COUNTRY_NOT_SERVED },
    })
    expect((await act(inWs, 'workspace.updateSettings', { country: 'CA' })).status).toBe(200)
    expect((await act(inWs, 'workspace.updateSettings', { country: null })).status).toBe(200)
    const [row] = await db
      .select()
      .from(workspace_settings)
      .where(eq(workspace_settings.workspace_id, made.body.data.workspace.id))
    expect(row?.country).toBeNull()
    const admins = await createWorkspace('Admin Made Abroad')
    expect((await act(admins.owner, 'workspace.getSettings', {})).body.data.servedCountries).toBeNull()
    expect((await act(admins.owner, 'workspace.updateSettings', { country: 'DE' })).status).toBe(200)
  })

  test('business lookups run before the trial, at most setupLookups of them per workspace', async () => {
    await rules({ turnstile: false, setupLookups: 2 })
    const { who, made } = await signUpThroughPage()
    const workspaceId = made.body.data.workspace.id
    const inWs = { headers: { ...who.headers, 'x-workspace-id': workspaceId } }
    const search = () => act(inWs, 'business.search', { query: 'Brightwater Plumbing, Portland' })
    expect((await search()).status).toBe(200)
    expect((await search()).status).toBe(200)
    expect(await search()).toMatchObject({
      status: 409,
      body: {
        ok: false,
        error: expect.stringContaining('business lookups for setting up'),
      },
    })
    // A workspace that is not waiting for its trial counts nothing.
    const other = await createWorkspace('Not on a bill')
    expect((await act(other.owner, 'business.search', { query: 'Brightwater' })).status).toBe(200)
    const markers = await db
      .select({ n: count() })
      .from(commands)
      .where(and(eq(commands.workspace_id, other.id), eq(commands.action, 'setup.lookup')))
    expect(markers[0]!.n).toBe(0)
  })

  test('no invitation emails and nothing else that reaches outside (security review F1)', async () => {
    const { who, made } = await signUpThroughPage()
    const workspaceId = made.body.data.workspace.id
    const inWs = { headers: { ...who.headers, 'x-workspace-id': workspaceId } }
    const send = vi.spyOn(emailSender, 'send').mockResolvedValue(undefined)
    try {
      const invite = await act(inWs, 'team.invite', {
        email: address('victim', 'example.com'),
        role: 'member',
      })
      expect(invite).toMatchObject({
        status: 409,
        body: { ok: false, error: PENDING_PAYMENT },
      })
      expect(send).not.toHaveBeenCalled()
    } finally {
      send.mockRestore()
    }
    for (const name of [
      'team.resendInvite',
      'webhook.create',
      'webhook.update',
      'webhook.test',
      'integration.subscribe',
      'voice.clone',
      'phoneNumber.lookupLine',
    ])
      expect(await act(inWs, name, {}), name).toMatchObject({
        status: 409,
        body: { ok: false, error: PENDING_PAYMENT },
      })
  })

  test('the onboarding opens at its last step (activate) and cannot go past it before the trial', async () => {
    const { who, made } = await signUpThroughPage()
    const workspaceId = made.body.data.workspace.id
    const inWs = { headers: { ...who.headers, 'x-workspace-id': workspaceId } }
    for (const step of ['phone', 'done', 'skipped'])
      expect(await act(inWs, 'onboarding.setStep', { step })).toMatchObject({
        status: 409,
        body: { ok: false, error: PENDING_PAYMENT },
      })
    expect((await act(inWs, 'onboarding.setStep', { step: 'notify' })).status).toBe(200)
    const me = await request(inWs, 'GET', '/v1/me')
    expect(me.body.onboarding.step).toBe('notify')
    // What the activation step shows: the plan, the trial, the first charge, the reminders and the terms.
    expect(me.body.workspace.activation).toMatchObject({
      trialDays: 14,
      reminderDays: [7, 1],
      includedMinutes: 50,
      standardMicrosPerMinute: 50_000,
      terms: {
        termsVersion: TERMS.TERMS_VERSION,
        privacyVersion: TERMS.PRIVACY_VERSION,
      },
    })
    const firstCharge = Date.parse(me.body.workspace.activation.firstChargeAt)
    expect(Math.abs(firstCharge - (Date.now() + 14 * DAY))).toBeLessThan(60_000)
    // A step past `activate` stored earlier (or none) opens `activate`.
    await db
      .update(workspace_settings)
      .set({ onboarding_step: 'phone' })
      .where(eq(workspace_settings.workspace_id, workspaceId))
    expect((await request(inWs, 'GET', '/v1/me')).body.onboarding.step).toBe('activate')
  })
})

describe("the owner's agent setup link before the trial (agent-first, 2026-11-18)", () => {
  let rpc = 0
  async function mcp(key: string, method: string, params: Record<string, unknown> = {}) {
    const res = await appRequest(`/mcp/setup/${key}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        [FROM]: randomIp(),
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++rpc, method, params }),
    })
    const text = await res.text()
    const json = text.startsWith('{')
      ? text
      : (text
          .split('\n')
          .find(l => l.startsWith('data: '))
          ?.slice(6) ?? 'null')
    // biome-ignore lint/suspicious/noExplicitAny: JSON-RPC bodies are asserted on in the tests
    return { status: res.status, body: JSON.parse(json) as any }
  }
  const tool = (key: string, name: string, args: Record<string, unknown> = {}) =>
    mcp(key, 'tools/call', { name, arguments: args })
  const errorText = (res: { body: { result: { isError?: boolean; content: { text: string }[] } } }) =>
    res.body.result.isError ? res.body.result.content[0]!.text : null
  type Step = { id: string; state: string; how?: string[] }
  const stepsOf = async (key: string, readOnly = true): Promise<Step[]> =>
    (await tool(key, 'setup_status', { read_only: readOnly })).body.result.structuredContent.workspaces[0].steps

  /** A sign-up waiting for Checkout and the owner's working setup link for its workspace. */
  async function waitingWithLink() {
    const { email, who, made } = await signUpThroughPage()
    const workspaceId: string = made.body.data.workspace.id
    const inWs = { headers: { ...who.headers, 'x-workspace-id': workspaceId } }
    const link = await act(inWs, 'agentSetup.createWorkspaceKey', {})
    expect(link.status, JSON.stringify(link.body)).toBe(200)
    return { email, inWs, workspaceId, billId: made.body.data.billId as string, key: link.body.data.key as string }
  }

  test('the owner makes one; it reaches the free steps and no billing or provider tool', async () => {
    const { key, workspaceId } = await waitingWithLink()
    const names = ((await mcp(key, 'tools/list')).body.result.tools as { name: string }[]).map(t => t.name)
    expect(names).toEqual(
      expect.arrayContaining(['setup_status', 'workspace_updateSettings', 'assistant_update', 'notifications_update']),
    )
    expect(names.filter(n => /billing|checkout|provider|workspace_create|team|apiKey/i.test(n))).toEqual([])
    const w = { workspaceId }
    expect(errorText(await tool(key, 'workspace_rename', { ...w, name: 'Brightwater Plumbing' }))).toBeNull()
    expect(errorText(await tool(key, 'workspace_updateSettings', { ...w, pickupMode: 'no_answer' }))).toBeNull()
    expect(errorText(await tool(key, 'notifications_update', { ...w, email: true }))).toBeNull()
    expect(errorText(await tool(key, 'onboarding_setStep', { ...w, step: 'notify' }))).toBeNull()
  })

  test("before the free steps are done, Start your trial waits; after them it is the owner's own row before the number", async () => {
    const { key, workspaceId } = await waitingWithLink()
    let steps = await stepsOf(key)
    const ids = steps.map(s => s.id)
    expect(ids.indexOf('activate')).toBeGreaterThan(ids.indexOf('notify'))
    expect(ids.indexOf('activate')).toBeLessThan(ids.indexOf('phone'))
    expect(steps.find(s => s.id === 'activate')?.state).toBe('todo')
    // The free steps (here: the onboarding moved past them, as the agent does with onboarding_setStep).
    expect(errorText(await tool(key, 'onboarding_setStep', { workspaceId, step: 'activate' }))).toBeNull()
    expect(errorText(await tool(key, 'workspace_updateSettings', { workspaceId, pickupMode: 'no_answer' }))).toBeNull()
    steps = await stepsOf(key, false)
    expect(steps.find(s => s.id === 'activate')).toMatchObject({ state: 'admin_only' })
    expect(steps.find(s => s.id === 'activate')!.how!.join(' ')).toMatch(/Never start it for them/)
    const phone = steps.find(s => s.id === 'phone')!
    expect(phone.state).toBe('todo')
    expect(phone.how!.join(' ')).toMatch(/Opens once the owner started the trial/)
    expect(phone.how!.join(' ')).not.toMatch(/purchase: true/)
    // Reading the status never moved the onboarding past `activate`.
    const [row] = await db.select().from(workspace_settings).where(eq(workspace_settings.workspace_id, workspaceId))
    expect(row?.onboarding_step).toBe('activate')
  })

  test('refused for the link while waiting: a number, a real call, going past activate, Checkout', async () => {
    const { key, workspaceId, email } = await waitingWithLink()
    const w = { workspaceId }
    for (const args of [
      { ...w, areaCode: '503', purchase: true, mode: 'new' },
      { ...w, e164: '+15035550123', purchase: false, mode: 'new' },
    ])
      expect(errorText(await tool(key, 'phoneNumber_setup', args))).toContain(PENDING_PAYMENT)
    expect(
      errorText(
        await tool(key, 'phoneNumber_checkForwarding', { ...w, phoneNumberId: 'pn_x', businessNumber: '+15035550100' }),
      ),
    ).toContain(PENDING_PAYMENT)
    expect(errorText(await tool(key, 'phoneNumber_lookupLine', { ...w, number: '+15035550100' }))).toContain(
      PENDING_PAYMENT,
    )
    for (const step of ['phone', 'done', 'skipped'])
      expect(errorText(await tool(key, 'onboarding_setStep', { ...w, step })), step).toContain(PENDING_PAYMENT)
    // No billing tool is offered, and the link's actor could not start Checkout (or any bill action) if one were.
    const account = await accountOf(email)
    const [keyRow] = await db
      .select({ id: agent_setup_keys.id })
      .from(agent_setup_keys)
      .where(eq(agent_setup_keys.created_by, account!.id))
    const asKey = await workspaceSetupActor(account!.id, keyRow!.id, workspaceId, 'owner')
    const inWs = await setupActorIn(asKey!, workspaceId)
    expect(inWs!.permissions).not.toContain('billing:manage')
    for (const name of ['billing.startCheckout', 'billing.confirmCheckout', 'agentSetup.createWorkspaceKey'])
      expect((await runAction(name, {}, inWs!)).status, name).toBe(403)
  })

  test('the link ends when the sweep deletes the sign-up, and with a disabled workspace', async () => {
    const swept = await waitingWithLink()
    expect((await mcp(swept.key, 'tools/list')).status).toBe(200)
    await db
      .update(billing_accounts)
      .set({ created_at: new Date(Date.now() - 15 * DAY).toISOString() })
      .where(eq(billing_accounts.id, swept.billId))
    await sweepSignUps(db)
    expect(await db.select().from(organization).where(eq(organization.id, swept.workspaceId))).toEqual([])
    expect((await mcp(swept.key, 'tools/list')).status).toBe(401)

    const disabled = await waitingWithLink()
    await db.update(organization).set({ disabledAt: new Date() }).where(eq(organization.id, disabled.workspaceId))
    expect(await mcp(disabled.key, 'tools/list')).toMatchObject({ status: 401, body: { code: 'SETUP_KEY_ENDED' } })
  })
})

describe('the daily sign-up sweep', () => {
  test('a partner sign-up without Checkout goes after 14 days: the partner, its drafts, its bill and the account', async () => {
    const { email, made } = await signUpThroughPage(address('partner'), { ...DETAILS, plan: 'partner' })
    const { billId, partner } = made.body.data
    const account = await accountOf(email)
    await db
      .update(billing_accounts)
      .set({ created_at: new Date(Date.now() - 15 * DAY).toISOString() })
      .where(eq(billing_accounts.id, billId))
    // A draft client workspace it prepared before paying (setup before payment, 2026-11-18) goes with it.
    const draftId = crypto.randomUUID().replaceAll('-', '')
    await db.insert(organization).values({
      id: draftId,
      name: 'Draft Client',
      slug: `draft-${draftId}`,
      partnerId: partner.id,
      billingAccountId: billId,
      billingState: 'pending_payment',
      createdAt: new Date(),
    })
    expect((await sweepSignUps(db)).bills).toBeGreaterThanOrEqual(1)
    expect(await db.select().from(organization).where(eq(organization.id, draftId))).toEqual([])
    expect(await db.select().from(partners).where(eq(partners.id, partner.id))).toEqual([])
    expect(await db.select().from(billing_accounts).where(eq(billing_accounts.id, billId))).toEqual([])
    expect(await db.select().from(user).where(eq(user.id, account!.id))).toEqual([])
    expect(await db.select().from(terms_acceptances).where(eq(terms_acceptances.billing_account_id, billId))).toEqual(
      [],
    )
  })

  test('deletes a sign-up without Checkout after 14 days: its workspace, bill and account', async () => {
    const { email, made } = await signUpThroughPage()
    const { billId, workspace } = made.body.data
    const account = await accountOf(email)
    // Not yet: 13 days old.
    await db
      .update(billing_accounts)
      .set({ created_at: new Date(Date.now() - 13 * DAY).toISOString() })
      .where(eq(billing_accounts.id, billId))
    await sweepSignUps(db)
    expect(await db.select().from(billing_accounts).where(eq(billing_accounts.id, billId))).toHaveLength(1)
    await db
      .update(billing_accounts)
      .set({ created_at: new Date(Date.now() - 15 * DAY).toISOString() })
      .where(eq(billing_accounts.id, billId))
    await db.insert(billing_balances).values({ billing_account_id: billId })
    const swept = await sweepSignUps(db)
    expect(swept.bills).toBeGreaterThanOrEqual(1)
    expect(await db.select().from(billing_accounts).where(eq(billing_accounts.id, billId))).toEqual([])
    expect(await db.select().from(organization).where(eq(organization.id, workspace.id))).toEqual([])
    expect(await db.select().from(user).where(eq(user.id, account!.id))).toEqual([])
    // Never a customer: the terms acceptance goes with the bill (A9).
    expect(await db.select().from(terms_acceptances).where(eq(terms_acceptances.billing_account_id, billId))).toEqual(
      [],
    )
  })

  test('the owner keeps their account when they are in another workspace; a bill that converted is never touched', async () => {
    const { email, made } = await signUpThroughPage()
    const account = await accountOf(email)
    const other = await signUp()
    const { body } = await asServerAdmin(other, () => request(other, 'POST', '/v1/workspaces', { name: 'Elsewhere' }))
    await db.insert(member).values({
      id: crypto.randomUUID(),
      organizationId: body.workspace.id,
      userId: account!.id,
      role: 'member',
      createdAt: new Date(),
    })
    const converted = await signUpThroughPage()
    const old = new Date(Date.now() - 30 * DAY).toISOString()
    await db.update(billing_accounts).set({ created_at: old }).where(eq(billing_accounts.id, made.body.data.billId))
    await db
      .update(billing_accounts)
      .set({ created_at: old, status: 'trialing' })
      .where(eq(billing_accounts.id, converted.made.body.data.billId))
    await sweepSignUps(db)
    expect(await db.select().from(billing_accounts).where(eq(billing_accounts.id, made.body.data.billId))).toEqual([])
    expect(await accountOf(email)).toBeDefined()
    expect(
      await db.select().from(billing_accounts).where(eq(billing_accounts.id, converted.made.body.data.billId)),
    ).toHaveLength(1)
  })

  test('a waiting bill with a linked Stripe subscription is kept, and the instance admins are told (N2)', async () => {
    const linked = await signUpThroughPage()
    const confirmed = await signUpThroughPage()
    const old = new Date(Date.now() - 30 * DAY).toISOString()
    const subscription = `sub_${crypto.randomUUID().slice(0, 12)}`
    await db
      .update(billing_accounts)
      .set({ created_at: old, stripe_subscription_id: subscription })
      .where(eq(billing_accounts.id, linked.made.body.data.billId))
    await db
      .update(billing_accounts)
      .set({ created_at: old, checkout_confirmed_at: old })
      .where(eq(billing_accounts.id, confirmed.made.body.data.billId))
    await sweepSignUps(db)
    for (const bill of [linked, confirmed])
      expect(
        await db.select().from(billing_accounts).where(eq(billing_accounts.id, bill.made.body.data.billId)),
      ).toHaveLength(1)
    const alerts = queued.filter(j => j.name === 'billing.alert' && j.data.kind === 'signup_kept')
    expect(alerts.map(a => a.data)).toEqual(
      expect.arrayContaining([
        { kind: 'signup_kept', bill: linked.made.body.data.billId, subscription },
        { kind: 'signup_kept', bill: confirmed.made.body.data.billId, subscription: null },
      ]),
    )
  })

  test('an account the sign-up page made that never signed up goes too; other accounts without a workspace stay', async () => {
    const email = address('codeonly')
    const { code } = await askCode(email)
    await enterCode(email, code!)
    const account = await accountOf(email)
    const kept = await signUp()
    const old = Date.now() - 15 * DAY
    await db
      .update(user)
      .set({ createdAt: new Date(old) })
      .where(eq(user.id, account!.id))
    await db
      .update(user)
      .set({ createdAt: new Date(old) })
      .where(eq(user.id, kept.userId))
    await db
      .update(signup_attempts)
      .set({ created_at: new Date(old - 60_000).toISOString() })
      .where(eq(signup_attempts.email_hash, emailHash(email)))
    await sweepSignUps(db)
    expect(await accountOf(email)).toBeUndefined()
    expect(await db.select().from(user).where(eq(user.id, kept.userId))).toHaveLength(1)
  })
})
