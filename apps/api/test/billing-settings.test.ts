// Billing provider and Stripe keys (docs/billing.md §7, billing-settings.ts): billing is `none` until Stripe has both
// keys and an instance admin turned it on; live keys only where the server allows them (BILLING_LIVE_KEYS=1); only an
// admin as themselves with the passkey changes the keys; keys are not swapped while on; turning on binds billing to
// one Stripe account; every change emails every instance admin. Instance-wide (provider keys, instance settings): its
// own database (vitest.config.ts).
import { BILLING_DEFAULTS, commands, instance_settings, provider_settings, user } from '@linedesk/db'
import { desc, eq, sql } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest'
import { adminHandlers } from '../src/admin-handlers.ts'
import { BILLING_RULES_KEY, billingRules } from '../src/billing-rules.ts'
import { billingProvider, billingSettingsHandlers, billingState, setBillingFetch } from '../src/billing-settings.ts'
import type { Actor } from '../src/context.ts'
import { db } from '../src/db.ts'
import { emailSender } from '../src/email.ts'
import { checkLedgerGuards } from '../src/ledger-guards.ts'
import { act, createWorkspace, type User } from './helpers.ts'

/** A made-up Stripe key, put together at run time so the secret scan never sees a key-shaped string in the repo. */
const fakeStripeKey = (kind: 'sk' | 'rk', mode: 'test' | 'live', body: string) => [kind, mode, body].join('_')
const TEST_KEY = fakeStripeKey('sk', 'test', '51MadeUpKey0123456789')
const OTHER_KEY = fakeStripeKey('rk', 'test', '51OtherAccount0123456789')
const LIVE_KEY = fakeStripeKey('rk', 'live', '51MadeUpKey0123456789')
const WEBHOOK = 'whsec_MadeUpSecret0123456789'

let operator: User
let owner: User
const envBefore = { ...process.env }

/** Stripe's GET /v1/account, answering with the account each key belongs to. */
const accounts: Record<string, string> = {
  [TEST_KEY]: 'acct_1Brightwater',
  [OTHER_KEY]: 'acct_1Elsewhere',
  [LIVE_KEY]: 'acct_1Brightwater',
}
const fakeStripe: typeof fetch = async (_url, init) => {
  const auth = new Headers(init?.headers).get('authorization') ?? ''
  const id = accounts[auth.replace(/^Bearer /, '')]
  const body = id
    ? { id, object: 'account', country: 'US', default_currency: 'usd' }
    : { error: { type: 'invalid_request_error', message: 'Invalid API Key' } }
  return new Response(JSON.stringify(body), {
    status: id ? 200 : 401,
    headers: { 'content-type': 'application/json', 'request-id': 'req_test' },
  })
}

beforeAll(async () => {
  const home = await createWorkspace('Linedesk Operations')
  operator = home.owner
  await db.update(user).set({ instanceAdmin: true }).where(eq(user.id, operator.userId))
  owner = (await createWorkspace('Brightwater Plumbing & Heating')).owner
  setBillingFetch(fakeStripe)
  // What the API does at start (server.ts): billing is in effect only once the ledger guards were found.
  expect(await checkLedgerGuards(db)).toBe(true)
})
afterEach(async () => {
  process.env = { ...envBefore }
  vi.restoreAllMocks()
  await db.delete(provider_settings)
  await db.delete(instance_settings)
})
afterAll(() => {
  process.env = { ...envBefore }
  setBillingFetch(null)
})

const setKeys = (values: Record<string, string>) => act(operator, 'provider.setKeys', { provider: 'stripe', values })
const state = async () => (await act(operator, 'billingEnabled.get', {})).body.data
const switchTo = (on: boolean, rebind?: boolean) =>
  act(operator, 'billingEnabled.set', { on, ...(rebind ? { rebind } : {}) })
const mailbox = () => {
  const mails: { to: string; subject: string; text: string }[] = []
  vi.spyOn(emailSender, 'send').mockImplementation(async e => void mails.push(e))
  return mails
}

describe('the switch', () => {
  test('off and none by default, also with keys stored', async () => {
    expect(await state()).toEqual({
      on: false,
      inEffect: 'none',
      connected: false,
      mode: null,
      liveAllowed: false,
      guardsOk: true,
    })
    expect((await setKeys({ secret_key: TEST_KEY, webhook_secret: WEBHOOK })).status).toBe(200)
    expect(await state()).toEqual({
      on: false,
      inEffect: 'none',
      connected: true,
      mode: 'test',
      liveAllowed: false,
      guardsOk: true,
    })
    expect((await billingProvider(db)).name).toBe('none')
  })

  test('on needs both keys; then Stripe is in effect, and off again is none', async () => {
    const refused = await switchTo(true)
    expect(refused.status).toBe(409)
    expect(JSON.stringify(refused.body)).toMatch(/Connect Stripe first/)
    await setKeys({ secret_key: TEST_KEY })
    expect((await switchTo(true)).status).toBe(409)

    await setKeys({ webhook_secret: WEBHOOK })
    const on = await switchTo(true)
    expect(on.status).toBe(200)
    expect(on.body.data).toMatchObject({ on: true, inEffect: 'stripe', mode: 'test' })
    expect((await billingProvider(db)).name).toBe('stripe')
    expect((await switchTo(false)).body.data).toMatchObject({ on: false, inEffect: 'none' })
  })

  test('not in effect while the ledger guards are missing: Stripe never runs then', async () => {
    await setKeys({ secret_key: TEST_KEY, webhook_secret: WEBHOOK })
    expect((await switchTo(true)).status).toBe(200)
    const error = console.error
    console.error = () => {}
    try {
      await db.execute(sql`alter table ledger_entries disable trigger ledger_entries_balance`)
      expect(await checkLedgerGuards(db)).toBe(false)
      expect(await state()).toMatchObject({ on: true, inEffect: 'none', guardsOk: false })
      expect((await billingProvider(db)).name).toBe('none')
    } finally {
      await db.execute(sql`alter table ledger_entries enable trigger ledger_entries_balance`)
      console.error = error
    }
    expect(await checkLedgerGuards(db)).toBe(true)
    expect((await billingProvider(db)).name).toBe('stripe')
  })

  test('only instance admins read or change it, and the change is in the audit log', async () => {
    expect((await act(owner, 'billingEnabled.get', {})).status).toBe(403)
    expect((await act(owner, 'billingEnabled.set', { on: false })).status).toBe(403)
    await switchTo(false)
    const [row] = await db
      .select()
      .from(commands)
      .where(eq(commands.action, 'billingEnabled.set'))
      .orderBy(desc(commands.created_at))
      .limit(1)
    expect(row).toBeDefined()
  })

  test('turning billing on or off emails every instance admin', async () => {
    await setKeys({ secret_key: TEST_KEY, webhook_secret: WEBHOOK })
    const mails = mailbox()
    await switchTo(true)
    await vi.waitFor(() => expect(mails.some(m => m.subject === 'Billing was turned on')).toBe(true))
    expect(mails.find(m => m.subject === 'Billing was turned on')!.text).toMatch(/acct_1Brightwater in test mode/)
    await switchTo(false)
    await vi.waitFor(() => expect(mails.some(m => m.subject === 'Billing was turned off')).toBe(true))
    // Setting it to what it already is says nothing.
    mails.length = 0
    await switchTo(false)
    await new Promise(r => setTimeout(r, 50))
    expect(mails.filter(m => /^Billing was turned/.test(m.subject))).toEqual([])
  })

  test('turning on binds billing to the Stripe account; keys of another one need rebind', async () => {
    await setKeys({ secret_key: TEST_KEY, webhook_secret: WEBHOOK })
    expect((await switchTo(true)).status).toBe(200)
    expect((await switchTo(false)).status).toBe(200)
    await setKeys({ secret_key: OTHER_KEY })
    const refused = await switchTo(true)
    expect(refused.status).toBe(409)
    expect(JSON.stringify(refused.body)).toMatch(/another Stripe account or mode \(acct_1Elsewhere, test\)/)
    expect((await state()).on).toBe(false)
    expect((await switchTo(true, true)).status).toBe(200)
    const [bound] = await db.select().from(instance_settings).where(eq(instance_settings.key, 'billing.stripeAccount'))
    expect(JSON.parse(bound!.value)).toEqual({ id: 'acct_1Elsewhere', mode: 'test' })
  })

  test('keys Stripe does not confirm do not turn billing on', async () => {
    await setKeys({ secret_key: fakeStripeKey('sk', 'test', '51NotKnownToStripe000'), webhook_secret: WEBHOOK })
    const refused = await switchTo(true)
    expect(refused.status).toBe(409)
    expect(JSON.stringify(refused.body)).toMatch(/Stripe did not confirm the account/)
    expect((await state()).on).toBe(false)
  })
})

describe('keys', () => {
  test('only Stripe secret or restricted keys and whsec_ secrets are taken', async () => {
    for (const secret_key of ['pk_test_abc123', 'whsec_abc123', 'sk_prod_abc123'])
      expect((await setKeys({ secret_key })).status).toBe(422)
    expect((await setKeys({ webhook_secret: fakeStripeKey('sk', 'test', 'abc123') })).status).toBe(422)
    expect(await db.select().from(provider_settings)).toEqual([])
  })

  test('live keys only with BILLING_LIVE_KEYS=1, and never in dev mode', async () => {
    const refused = await setKeys({ secret_key: LIVE_KEY, webhook_secret: WEBHOOK })
    expect(refused.status).toBe(409)
    expect(JSON.stringify(refused.body)).toMatch(/Live Stripe keys are refused on this install/)
    expect(await db.select().from(provider_settings)).toEqual([])
    process.env.BILLING_LIVE_KEYS = '1'
    process.env.LINEDESK_MODE = 'dev'
    expect((await setKeys({ secret_key: LIVE_KEY, webhook_secret: WEBHOOK })).status).toBe(409)
    delete process.env.LINEDESK_MODE
    expect((await setKeys({ secret_key: LIVE_KEY, webhook_secret: WEBHOOK })).status).toBe(200)
    expect(await state()).toMatchObject({ mode: 'live', liveAllowed: true })

    // A live key stored while allowed, then the server no longer allows it: shown, not usable, the switch refuses.
    await db.update(instance_settings).set({ value: 'on' }).where(eq(instance_settings.key, 'billing.enabled'))
    delete process.env.BILLING_LIVE_KEYS
    expect(await billingState(db)).toMatchObject({ on: true, inEffect: 'none', mode: 'live', liveAllowed: false })
    expect((await billingProvider(db)).name).toBe('none')
    expect((await switchTo(true)).status).toBe(409)
  })

  test('never read from .env', async () => {
    process.env.STRIPE_SECRET_KEY = TEST_KEY
    process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK
    expect(await billingState(db)).toMatchObject({ connected: false, inEffect: 'none' })
    expect((await switchTo(true)).status).toBe(409)
  })

  test('only an admin signed in as themselves, with the passkey, changes them', async () => {
    process.env.ADMIN_SECOND_FACTOR = 'on'
    const me: Actor = {
      actorId: operator.userId,
      role: 'member',
      workspaceId: null,
      permissions: ['instance:admin'],
      sessionId: 's',
      passkeyConfirmed: true,
    }
    const now = new Date().toISOString()
    const setInput = { provider: 'stripe', values: { secret_key: TEST_KEY, webhook_secret: WEBHOOK } }
    for (const actor of [
      { ...me, setupKeyId: 'ask_1' },
      { ...me, apiKeyId: 'key_1' },
      { ...me, impersonation: { by: 'admin_1', sessionId: 's0', expiresAt: new Date(Date.now() + 60_000) } },
      { ...me, passkeyConfirmed: undefined },
    ]) {
      await expect(adminHandlers['provider.setKeys']!({ tx: db, actor, now }, setInput)).rejects.toThrow(
        /signed in as themselves|confirm with your passkey/,
      )
      await expect(
        adminHandlers['provider.clearKeys']!({ tx: db, actor, now }, { provider: 'stripe' }),
      ).rejects.toThrow(/signed in as themselves|confirm with your passkey/)
      await expect(
        adminHandlers['provider.setActive']!({ tx: db, actor, now }, { category: 'billing', provider: 'stripe' }),
      ).rejects.toThrow(/signed in as themselves|confirm with your passkey/)
    }
    expect(await db.select().from(provider_settings)).toEqual([])
    await adminHandlers['provider.setKeys']!({ tx: db, actor: me, now }, setInput)
    expect((await billingState(db)).connected).toBe(true)
    // Other providers keep their rules: a setup link still sets them.
    await adminHandlers['provider.setKeys']!(
      { tx: db, actor: { ...me, setupKeyId: 'ask_1' }, now },
      { provider: 'deepgram', values: { api_key: 'dg_made_up_key_0123456789' } },
    )
  })

  test('turning on or rebinding needs the same check as a key change; turning off does not', async () => {
    await setKeys({ secret_key: TEST_KEY, webhook_secret: WEBHOOK })
    process.env.ADMIN_SECOND_FACTOR = 'on'
    const me: Actor = {
      actorId: operator.userId,
      role: 'member',
      workspaceId: null,
      permissions: ['instance:admin'],
      sessionId: 's',
      passkeyConfirmed: true,
    }
    const now = new Date().toISOString()
    const set = billingSettingsHandlers['billingEnabled.set']!
    for (const input of [{ on: true }, { on: true, rebind: true }, { on: false, rebind: true }])
      for (const actor of [
        { ...me, setupKeyId: 'ask_1' },
        { ...me, passkeyConfirmed: undefined },
      ])
        await expect(set({ tx: db, actor, now }, input), JSON.stringify(input)).rejects.toThrow(
          /signed in as themselves|confirm with your passkey/,
        )
    expect((await billingState(db)).on).toBe(false)
    await set({ tx: db, actor: me, now }, { on: true })
    expect((await billingState(db)).on).toBe(true)
    await set({ tx: db, actor: { ...me, passkeyConfirmed: undefined }, now }, { on: false })
    expect((await billingState(db)).on).toBe(false)
  })

  test('not swapped while billing is on; removing them turns billing off', async () => {
    await setKeys({ secret_key: TEST_KEY, webhook_secret: WEBHOOK })
    await switchTo(true)
    const refused = await setKeys({ secret_key: OTHER_KEY })
    expect(refused.status).toBe(409)
    expect(JSON.stringify(refused.body)).toMatch(/Turn billing off before changing the Stripe secret key/)
    expect((await setKeys({ secret_key: OTHER_KEY, webhook_secret: WEBHOOK })).status).toBe(409)
    // The webhook secret alone may be rotated while on, and the admins hear of it.
    const mails = mailbox()
    expect((await setKeys({ webhook_secret: 'whsec_Rotated0123456789' })).status).toBe(200)
    await vi.waitFor(() => expect(mails.some(m => /^Stripe settings changed/.test(m.subject))).toBe(true))
    expect(await state()).toMatchObject({ on: true, inEffect: 'stripe' })
    expect((await act(operator, 'provider.clearKeys', { provider: 'stripe' })).status).toBe(200)
    expect(await state()).toMatchObject({ on: false, inEffect: 'none', connected: false })
    // New keys later do not turn it on by themselves.
    await setKeys({ secret_key: TEST_KEY, webhook_secret: WEBHOOK })
    expect(await state()).toMatchObject({ on: false, inEffect: 'none', connected: true })
  })

  test('a change of the keys emails every instance admin, without the key', async () => {
    const mails = mailbox()
    expect((await setKeys({ secret_key: TEST_KEY, webhook_secret: WEBHOOK })).status).toBe(200)
    await vi.waitFor(() => expect(mails.some(m => /^Stripe settings changed/.test(m.subject))).toBe(true))
    const alert = mails.find(m => /^Stripe settings changed/.test(m.subject))!
    expect(alert.text).toMatch(/They control billing: charges, refunds and customers/)
    expect(JSON.stringify(mails)).not.toContain(TEST_KEY)
    expect(JSON.stringify(mails)).not.toContain(WEBHOOK)

    mails.length = 0
    expect((await act(operator, 'provider.clearKeys', { provider: 'stripe' })).status).toBe(200)
    await vi.waitFor(() => expect(mails.some(m => /^Stripe settings removed/.test(m.subject))).toBe(true))
  })

  test('the keys never come back and the command log holds them redacted', async () => {
    await setKeys({ secret_key: TEST_KEY, webhook_secret: WEBHOOK })
    const rows = await db.select().from(commands).where(eq(commands.action, 'provider.setKeys'))
    expect(JSON.stringify(rows)).not.toContain(TEST_KEY)
    expect(JSON.stringify(rows)).not.toContain(WEBHOOK)
  })
})

describe('the billing rules setting (docs/billing.md §7a)', () => {
  test('without a row the defaults; a stored row over them; a row that does not parse is the defaults', async () => {
    await db.delete(instance_settings).where(eq(instance_settings.key, BILLING_RULES_KEY))
    expect(await billingRules(db)).toEqual(BILLING_DEFAULTS)
    await db
      .insert(instance_settings)
      .values({ key: BILLING_RULES_KEY, value: JSON.stringify({ extraNumberCents: 500 }) })
    expect(await billingRules(db)).toEqual({ ...BILLING_DEFAULTS, extraNumberCents: 500 })
    await db.update(instance_settings).set({ value: '{' }).where(eq(instance_settings.key, BILLING_RULES_KEY))
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await billingRules(db)).toEqual(BILLING_DEFAULTS)
    expect(errors).toHaveBeenCalled()
    errors.mockRestore()
    await db.delete(instance_settings).where(eq(instance_settings.key, BILLING_RULES_KEY))
  })
})
