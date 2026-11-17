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
  billing_accounts,
  billing_balances,
  commands,
  instance_settings,
  member,
  organization,
  signup_attempts,
  user,
} from '@linedesk/db'
import { and, count, eq, gte } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { WEB_ORIGIN } from '../src/auth.ts'
import { db } from '../src/db.ts'
import { emailSender } from '../src/email.ts'
import { setJobQueue } from '../src/jobs.ts'
import { setProviderKeys } from '../src/provider-settings.ts'
import {
  emailHash,
  PENDING_PAYMENT,
  SELF_SERVE_KEY,
  SIGNUP_RULES_KEY,
  selfServeState,
  setTurnstileFetch,
  TURNSTILE_VERIFY_URL,
} from '../src/self-serve.ts'
import { COUNTRY_NOT_YET, sweepSignUps } from '../src/signup-handlers.ts'
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
beforeEach(async () => {
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
}

/** The whole page: a code, signed in, account.signUp. */
async function signUpThroughPage(email = address('owner'), details: Record<string, unknown> = DETAILS) {
  const { code } = await askCode(email)
  expect(code).toMatch(/^\d{6}$/)
  const { status, who, body } = await enterCode(email, code!)
  expect(status, body).toBe(200)
  const made = await request(who, 'POST', '/v1/signup', details)
  return { email, who, made }
}

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

  test("open: the config says so and names the sign-up countries and the plan at the install's prices", async () => {
    expect((await request(anonymous, 'GET', '/v1/signup/config')).body).toMatchObject({
      open: true,
      countries: ['US', 'CA', 'PR'],
      // The sign-up page shows the price and the trial (billing tour, G3), from the rules, not written into the page.
      plan: { monthlyCents: 1100, yearlyCents: 10_800, trialDays: 14 },
    })
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
  })

  test('one waiting sign-up per account: asked again, it answers the one there is', async () => {
    const { who, made } = await signUpThroughPage()
    const again = await request(who, 'POST', '/v1/signup', { ...DETAILS, businessName: 'Second Business' })
    expect(again.body).toMatchObject({ ok: true, data: { billId: made.body.data.billId, existing: true } })
    expect(again.body.data.workspace.id).toBe(made.body.data.workspace.id)
  })

  test('outside the US, Canada and Puerto Rico: not yet, nothing is made', async () => {
    const { email, made } = await signUpThroughPage(address('abroad'), { ...DETAILS, country: 'de' })
    expect(made).toMatchObject({ status: 409, body: { ok: false, error: COUNTRY_NOT_YET } })
    const account = await accountOf(email)
    expect(await db.select().from(billing_accounts).where(eq(billing_accounts.owner_user_id, account!.id))).toEqual([])
  })

  test('the partner plan is postponed (LIN-322): refused as input', async () => {
    const { made } = await signUpThroughPage(address('partner'), { ...DETAILS, plan: 'partner' })
    expect(made.status).toBe(422)
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
  test('no number, no browser test call, no agent setup link', async () => {
    const { who, made } = await signUpThroughPage()
    const workspaceId = made.body.data.workspace.id
    const inWs = { headers: { ...who.headers, 'x-workspace-id': workspaceId } }
    for (const [name, input] of [
      ['phoneNumber.setup', { areaCode: '503', purchase: true }],
      ['assistant.startTestCall', {}],
      ['agentSetup.createWorkspaceKey', {}],
    ] as const)
      expect(await act(inWs, name, input)).toMatchObject({ status: 409, body: { ok: false, error: PENDING_PAYMENT } })
  })

  test('no invitation emails and nothing else that reaches outside (security review F1)', async () => {
    const { who, made } = await signUpThroughPage()
    const workspaceId = made.body.data.workspace.id
    const inWs = { headers: { ...who.headers, 'x-workspace-id': workspaceId } }
    const send = vi.spyOn(emailSender, 'send').mockResolvedValue(undefined)
    try {
      const invite = await act(inWs, 'team.invite', { email: address('victim', 'example.com'), role: 'member' })
      expect(invite).toMatchObject({ status: 409, body: { ok: false, error: PENDING_PAYMENT } })
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
      'business.search',
      'business.import',
      'knowledge.import',
      'phoneNumber.lookupLine',
    ])
      expect(await act(inWs, name, {}), name).toMatchObject({
        status: 409,
        body: { ok: false, error: PENDING_PAYMENT },
      })
  })
})

describe('the daily sign-up sweep', () => {
  test('deletes a sign-up without Checkout after 7 days: its workspace, bill and account', async () => {
    const { email, made } = await signUpThroughPage()
    const { billId, workspace } = made.body.data
    const account = await accountOf(email)
    // Not yet: 6 days old.
    await db
      .update(billing_accounts)
      .set({ created_at: new Date(Date.now() - 6 * DAY).toISOString() })
      .where(eq(billing_accounts.id, billId))
    await sweepSignUps(db)
    expect(await db.select().from(billing_accounts).where(eq(billing_accounts.id, billId))).toHaveLength(1)
    await db
      .update(billing_accounts)
      .set({ created_at: new Date(Date.now() - 8 * DAY).toISOString() })
      .where(eq(billing_accounts.id, billId))
    await db.insert(billing_balances).values({ billing_account_id: billId })
    const swept = await sweepSignUps(db)
    expect(swept.bills).toBeGreaterThanOrEqual(1)
    expect(await db.select().from(billing_accounts).where(eq(billing_accounts.id, billId))).toEqual([])
    expect(await db.select().from(organization).where(eq(organization.id, workspace.id))).toEqual([])
    expect(await db.select().from(user).where(eq(user.id, account!.id))).toEqual([])
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
    const old = Date.now() - 8 * DAY
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
