// Telnyx outbound setup against mocked HTTP: only objects named for the call test are touched.
import { describe, expect, test } from 'vitest'
import {
  createTelnyxOutbound,
  DEFAULT_SPEND_LIMITS,
  setTelnyxDestinations,
  sipUserName,
  spendLimitWarnings,
  telnyxSpendLimits,
  transferOutboundSipFromEnv,
} from './index.ts'

type Call = { method: string; path: string; body?: Record<string, unknown> }
type Account = {
  profiles: { id: string; name: string }[]
  connections: { id: string; connection_name: string }[]
  numbers: { id: string; phone_number: string; connection_id: string | null }[]
  /** Telnyx keeps another destination list than the one sent. */
  ignoresWhitelist?: boolean
  /** What Telnyx returns for the spend fields instead of what was sent (a profile it did not change). */
  keptSpend?: Record<string, unknown>
}

const SPEND_FIELDS = ['max_destination_rate', 'daily_spend_limit', 'daily_spend_limit_enabled'] as const
/** The spend fields a saved profile comes back with: what was sent, unless the account keeps others. */
const savedSpend = (account: Account, body: Record<string, unknown>) =>
  account.keptSpend ?? Object.fromEntries(SPEND_FIELDS.filter(f => f in body).map(f => [f, body[f]]))
/** What every Linedesk voice profile is sent besides its countries, with the default limits. */
const DEFAULT_SPEND_BODY = { max_destination_rate: 0.1, daily_spend_limit: '50.00', daily_spend_limit_enabled: true }

const CALLER = '+19715550188'

function mockTelnyx(account: Account) {
  const calls: Call[] = []
  const fakeFetch: typeof fetch = async (url, init) => {
    const path = decodeURIComponent(String(url).replace('https://api.telnyx.com/v2', ''))
    const body = init!.body ? JSON.parse(String(init!.body)) : undefined
    const method = init!.method!
    calls.push({ method, path, body })
    const ok = (data: unknown) => Response.json({ data })
    if (method === 'GET' && path.startsWith('/outbound_voice_profiles')) return ok(account.profiles)
    if (method === 'POST' && path === '/outbound_voice_profiles') {
      account.profiles.push({ id: 'ovp_1', name: body.name })
      return ok({
        ...account.profiles.at(-1),
        whitelisted_destinations: body.whitelisted_destinations,
        ...savedSpend(account, body),
      })
    }
    if (method === 'GET' && path.startsWith('/credential_connections')) return ok(account.connections)
    if (method === 'POST' && path === '/credential_connections') {
      account.connections.push({ id: 'conn_test', connection_name: body.connection_name })
      return ok(account.connections.at(-1))
    }
    if (method === 'PATCH' && path.startsWith('/credential_connections/')) return ok({ id: path.split('/')[2] })
    if (method === 'PATCH' && path.startsWith('/outbound_voice_profiles/'))
      return ok({
        id: path.split('/')[2],
        whitelisted_destinations: account.ignoresWhitelist ? ['US', 'CA'] : body.whitelisted_destinations,
        ...savedSpend(account, body),
      })
    if (method === 'GET' && path.startsWith('/phone_numbers?')) return ok(account.numbers.filter(n => path.endsWith(n.phone_number)))
    if (method === 'PATCH' && path.startsWith('/phone_numbers/')) {
      const number = account.numbers.find(n => path.endsWith(n.id))!
      number.connection_id = body.connection_id
      return ok(number)
    }
    return Response.json({ errors: [{ detail: `no mock for ${method} ${path}` }] }, { status: 404 })
  }
  return { outbound: createTelnyxOutbound({ apiKey: 'KEY', fetch: fakeFetch }), calls, fetch: fakeFetch, account }
}

const freshAccount = (): Account => ({
  profiles: [{ id: 'ovp_other', name: 'Another business' }],
  connections: [{ id: 'conn_other', connection_name: 'Another business' }],
  numbers: [{ id: 'num_b', phone_number: CALLER, connection_id: null }, { id: 'num_other', phone_number: '+15035550100', connection_id: 'conn_other' }],
})

describe('telnyx outbound for the call test', () => {
  test('creates profile and connection, attaches the caller number, returns trunk settings', async () => {
    const account = freshAccount()
    const { outbound, calls } = mockTelnyx(account)
    const sip = await outbound.ensureOutboundSip(CALLER)
    expect(sip).toMatchObject({ address: 'sip.telnyx.com', username: 'cflinedesktestcaller', headers: { 'X-Telnyx-Username': 'cflinedesktestcaller' } })
    expect(sip.password.length).toBeGreaterThanOrEqual(20)
    const created = calls.find(c => c.method === 'POST' && c.path === '/credential_connections')!
    expect(created.body).toMatchObject({ connection_name: 'linedesk-test-caller', user_name: 'cflinedesktestcaller', password: sip.password, outbound: { outbound_voice_profile_id: 'ovp_1' } })
    expect(account.numbers.find(n => n.id === 'num_b')?.connection_id).toBe('conn_test')
  })

  test('a second run reuses both and only sets a new password', async () => {
    const account = freshAccount()
    await mockTelnyx(account).outbound.ensureOutboundSip(CALLER)
    const { outbound, calls } = mockTelnyx(account)
    const again = await outbound.ensureOutboundSip(CALLER)
    expect(calls.filter(c => c.method === 'POST')).toEqual([])
    expect(calls.find(c => c.method === 'PATCH' && c.path.startsWith('/credential_connections'))).toMatchObject({ path: '/credential_connections/conn_test', body: { password: again.password } })
  })

  test('never touches objects with another name, such as the connection of another business', async () => {
    const { outbound, calls } = mockTelnyx(freshAccount())
    await outbound.ensureOutboundSip(CALLER)
    for (const call of calls.filter(c => c.method !== 'GET')) {
      expect(call.path).not.toMatch(/conn_other|ovp_other|num_other/)
    }
  })

  test('refuses a caller number that is missing or serves another connection', async () => {
    await expect(mockTelnyx(freshAccount()).outbound.ensureOutboundSip('+19715550000')).rejects.toThrow('+19715550000 is not in the Telnyx account')
    await expect(mockTelnyx(freshAccount()).outbound.ensureOutboundSip('+15035550100')).rejects.toThrow('+15035550100 is attached to another connection')
  })

  test('warm transfer: its own connection "linedesk-outbound", no number attached to it', async () => {
    const account = freshAccount()
    const { calls, fetch } = mockTelnyx(account)
    const sip = await transferOutboundSipFromEnv({ TELEPHONY_PROVIDER: 'telnyx', TELNYX_API_KEY: 'KEY' }, fetch)
    expect(sip).toMatchObject({ address: 'sip.telnyx.com', username: 'cflinedeskoutbound' })
    expect(calls.find(c => c.method === 'POST' && c.path === '/credential_connections')?.body).toMatchObject({ connection_name: 'linedesk-outbound' })
    expect(calls.filter(c => c.path.startsWith('/phone_numbers'))).toEqual([])
    expect(account.numbers.map(n => n.connection_id)).toEqual([null, 'conn_other'])
  })

  test('warm transfer needs Telnyx for now', async () => {
    await expect(transferOutboundSipFromEnv({ TELEPHONY_PROVIDER: 'twilio' })).rejects.toThrow(/Telnyx only/)
    await expect(transferOutboundSipFromEnv({})).rejects.toThrow(/Telnyx only/)
    await expect(transferOutboundSipFromEnv({ TELEPHONY_PROVIDER: 'telnyx' })).rejects.toThrow('TELNYX_API_KEY is not set')
  })

  test('the voice profile is US-only: created on the global plan with only the US as destination, and put back to US-only', async () => {
    const account = freshAccount()
    const first = mockTelnyx(account)
    await first.outbound.ensureOutboundSip(CALLER)
    // Telnyx refuses the US plan for new profiles; only conversational + global + rate-deck is accepted.
    expect(first.calls.find(c => c.method === 'POST' && c.path === '/outbound_voice_profiles')?.body).toEqual({
      name: 'linedesk-test-caller',
      traffic_type: 'conversational',
      service_plan: 'global',
      usage_payment_method: 'rate-deck',
      whitelisted_destinations: ['US'],
      ...DEFAULT_SPEND_BODY,
    })
    const again = mockTelnyx(account)
    await again.outbound.ensureOutboundSip(CALLER)
    expect(again.calls.find(c => c.method === 'PATCH' && c.path === '/outbound_voice_profiles/ovp_1')?.body).toEqual({
      name: 'linedesk-test-caller',
      whitelisted_destinations: ['US'],
      ...DEFAULT_SPEND_BODY,
    })
  })

  test('fails closed when Telnyx does not keep the profile to the US', async () => {
    const account = { ...freshAccount(), ignoresWhitelist: true }
    await mockTelnyx(account).outbound.ensureOutboundSip(CALLER)
    await expect(mockTelnyx(account).outbound.ensureOutboundSip(CALLER)).rejects.toThrow(/not limited to US/)
  })

  test('a profile for other countries: created and put back with exactly that list', async () => {
    const account = freshAccount()
    const { calls, fetch } = mockTelnyx(account)
    await createTelnyxOutbound({
      apiKey: 'KEY',
      name: 'linedesk-outbound-ws1',
      destinations: ['de', 'US', 'DE'],
      fetch,
    }).ensureOutboundSip()
    expect(
      calls.find(c => c.method === 'POST' && c.path === '/outbound_voice_profiles')?.body?.whitelisted_destinations,
    ).toEqual(['DE', 'US'])
  })

  test('never an empty or malformed destination list', () => {
    expect(() => createTelnyxOutbound({ apiKey: 'KEY', name: 'linedesk-x', destinations: [] })).toThrow(
      /destination list/,
    )
    expect(() => createTelnyxOutbound({ apiKey: 'KEY', name: 'linedesk-x', destinations: ['*'] })).toThrow(
      /destination list/,
    )
  })

  test('setTelnyxDestinations changes only the existing profile of that name, and fails closed', async () => {
    const account = freshAccount()
    account.profiles.push({ id: 'ovp_ws', name: 'linedesk-outbound-ws1' })
    const { calls, fetch } = mockTelnyx(account)
    expect(
      await setTelnyxDestinations({ apiKey: 'KEY', name: 'linedesk-outbound-ws1', destinations: ['KR', 'DE'], fetch }),
    ).toBe(true)
    expect(calls.filter(c => c.method === 'PATCH')).toEqual([
      {
        method: 'PATCH',
        path: '/outbound_voice_profiles/ovp_ws',
        body: { name: 'linedesk-outbound-ws1', whitelisted_destinations: ['DE', 'KR'], ...DEFAULT_SPEND_BODY },
      },
    ])
    expect(
      await setTelnyxDestinations({ apiKey: 'KEY', name: 'linedesk-outbound-none', destinations: ['DE'], fetch }),
    ).toBe(false)
    await expect(
      setTelnyxDestinations({ apiKey: 'KEY', name: 'Another business', destinations: ['DE'], fetch }),
    ).rejects.toThrow(/only objects named/)
    const ignoring = mockTelnyx({ ...account, ignoresWhitelist: true })
    await expect(
      setTelnyxDestinations({
        apiKey: 'KEY',
        name: 'linedesk-outbound-ws1',
        destinations: ['DE'],
        fetch: ignoring.fetch,
      }),
    ).rejects.toThrow(/not limited to DE/)
    await expect(
      setTelnyxDestinations({ apiKey: 'KEY', name: 'linedesk-outbound-ws1', destinations: [], fetch }),
    ).rejects.toThrow(/destination list/)
  })

  test('every profile gets a max destination rate and a daily spend limit, on create and on every run after', async () => {
    const account = freshAccount()
    const limits = { maxDestinationRate: 0.05, dailySpendLimit: 20 }
    const { calls, fetch } = mockTelnyx(account)
    const outbound = createTelnyxOutbound({ apiKey: 'KEY', spendLimits: limits, fetch })
    await outbound.ensureOutboundSip(CALLER)
    await outbound.ensureOutboundSip(CALLER)
    const sent = calls.filter(c => c.path.startsWith('/outbound_voice_profiles') && c.method !== 'GET')
    expect(sent.map(c => c.method)).toEqual(['POST', 'PATCH'])
    for (const call of sent)
      expect(call.body).toMatchObject({
        max_destination_rate: 0.05,
        daily_spend_limit: '20.00',
        daily_spend_limit_enabled: true,
      })
  })

  test('fails closed when a saved profile has no spend limits, or higher ones than configured', async () => {
    const without = { ...freshAccount(), profiles: [{ id: 'ovp_old', name: 'linedesk-test-caller' }], keptSpend: {} }
    await expect(mockTelnyx(without).outbound.ensureOutboundSip(CALLER)).rejects.toThrow(/no max destination rate/)
    const kept = (keptSpend: Record<string, unknown>) => ({ ...freshAccount(), keptSpend })
    const fine = { max_destination_rate: 0.1, daily_spend_limit: '50.00', daily_spend_limit_enabled: true }
    await expect(
      mockTelnyx(kept({ ...fine, max_destination_rate: 0.5 })).outbound.ensureOutboundSip(CALLER),
    ).rejects.toThrow(/max destination rate of at most \$0.1\/min \(0.5\)/)
    await expect(
      mockTelnyx(kept({ ...fine, daily_spend_limit: '500.00' })).outbound.ensureOutboundSip(CALLER),
    ).rejects.toThrow(/daily spend limit of at most \$50/)
    await expect(
      mockTelnyx(kept({ ...fine, daily_spend_limit_enabled: false })).outbound.ensureOutboundSip(CALLER),
    ).rejects.toThrow(/daily spend limit/)
    await expect(
      mockTelnyx(kept({ max_destination_rate: 0.1, daily_spend_limit_enabled: true })).outbound.ensureOutboundSip(CALLER),
    ).rejects.toThrow(/daily spend limit/)
    // Lower than configured is fine (Telnyx may round), and the rate may come back as a string.
    await mockTelnyx(kept({ ...fine, max_destination_rate: '0.08', daily_spend_limit: '25' })).outbound.ensureOutboundSip(CALLER)
  })

  test('setTelnyxDestinations brings an older profile to the spend limits, and fails closed when Telnyx keeps none', async () => {
    const account = freshAccount()
    account.profiles.push({ id: 'ovp_install', name: 'linedesk-outbound' })
    const { calls, fetch } = mockTelnyx(account)
    const spendLimits = { maxDestinationRate: 0.2, dailySpendLimit: 100 }
    expect(await setTelnyxDestinations({ apiKey: 'KEY', name: 'linedesk-outbound', destinations: ['US'], spendLimits, fetch })).toBe(true)
    expect(calls.find(c => c.method === 'PATCH')?.body).toEqual({
      name: 'linedesk-outbound',
      whitelisted_destinations: ['US'],
      max_destination_rate: 0.2,
      daily_spend_limit: '100.00',
      daily_spend_limit_enabled: true,
    })
    const keeping = mockTelnyx({ ...account, keptSpend: { daily_spend_limit_enabled: false } })
    await expect(
      setTelnyxDestinations({ apiKey: 'KEY', name: 'linedesk-outbound', destinations: ['US'], fetch: keeping.fetch }),
    ).rejects.toThrow(/no max destination rate/)
  })

  test('every PATCH of a voice profile carries its name (Telnyx requires it)', async () => {
    const account = freshAccount()
    account.profiles.push({ id: 'ovp_tc', name: 'linedesk-test-caller' })
    const { calls, fetch } = mockTelnyx(account)
    await createTelnyxOutbound({ apiKey: 'KEY', fetch }).ensureOutboundSip(CALLER)
    await setTelnyxDestinations({ apiKey: 'KEY', name: 'linedesk-test-caller', destinations: ['US'], fetch })
    const patches = calls.filter(c => c.method === 'PATCH' && c.path.startsWith('/outbound_voice_profiles/'))
    expect(patches).toHaveLength(2)
    for (const patch of patches) expect(patch.body?.name).toBe('linedesk-test-caller')
  })

  test('without countries to give: only the name and the spend limits, the countries stay as they are', async () => {
    const account = freshAccount()
    account.profiles.push({ id: 'ovp_ws', name: 'linedesk-outbound-ws1' })
    const { calls, fetch } = mockTelnyx(account)
    expect(await setTelnyxDestinations({ apiKey: 'KEY', name: 'linedesk-outbound-ws1', destinations: null, fetch })).toBe(
      true,
    )
    expect(calls.find(c => c.method === 'PATCH')?.body).toEqual({ name: 'linedesk-outbound-ws1', ...DEFAULT_SPEND_BODY })
    const keeping = mockTelnyx({ ...account, keptSpend: {} })
    await expect(
      setTelnyxDestinations({ apiKey: 'KEY', name: 'linedesk-outbound-ws1', destinations: null, fetch: keeping.fetch }),
    ).rejects.toThrow(/no max destination rate/)
  })

  test('the set-up reports whether the spend limits were confirmed', async () => {
    const seen: (string | null)[] = []
    const onSpendCaps = (problem: string | null) => {
      seen.push(problem)
    }
    const ok = mockTelnyx(freshAccount())
    await createTelnyxOutbound({ apiKey: 'KEY', fetch: ok.fetch, onSpendCaps }).ensureOutboundSip(CALLER)
    const refused = mockTelnyx({ ...freshAccount(), keptSpend: {} })
    await expect(
      createTelnyxOutbound({ apiKey: 'KEY', fetch: refused.fetch, onSpendCaps }).ensureOutboundSip(CALLER),
    ).rejects.toThrow(/no max destination rate/)
    expect(seen).toEqual([null, expect.stringMatching(/no max destination rate/)])
  })

  test('warns about limits so high they barely limit', () => {
    expect(spendLimitWarnings(DEFAULT_SPEND_LIMITS)).toEqual([])
    expect(spendLimitWarnings({ maxDestinationRate: 1, dailySpendLimit: 500 })).toEqual([])
    const warnings = spendLimitWarnings({ maxDestinationRate: 2.5, dailySpendLimit: 5000 })
    expect(warnings).toHaveLength(2)
    expect(warnings[0]).toMatch(/TELNYX_MAX_DESTINATION_RATE is \$2.5\/min, above \$1\/min/)
    expect(warnings[1]).toMatch(/TELNYX_DAILY_SPEND_LIMIT is \$5000 a day/)
  })

  test('spend limits from the env: defaults, overrides, and refused values', () => {
    expect(telnyxSpendLimits({})).toEqual(DEFAULT_SPEND_LIMITS)
    expect(DEFAULT_SPEND_LIMITS).toEqual({ maxDestinationRate: 0.1, dailySpendLimit: 50 })
    expect(telnyxSpendLimits({ TELNYX_MAX_DESTINATION_RATE: ' ', TELNYX_DAILY_SPEND_LIMIT: '' })).toEqual(DEFAULT_SPEND_LIMITS)
    expect(telnyxSpendLimits({ TELNYX_MAX_DESTINATION_RATE: '0.25', TELNYX_DAILY_SPEND_LIMIT: '120' })).toEqual({
      maxDestinationRate: 0.25,
      dailySpendLimit: 120,
    })
    for (const value of ['0', '-1', 'abc', 'Infinity'])
      expect(() => telnyxSpendLimits({ TELNYX_DAILY_SPEND_LIMIT: value })).toThrow(/not a positive amount/)
    expect(() => telnyxSpendLimits({ TELNYX_MAX_DESTINATION_RATE: '0' })).toThrow(/TELNYX_MAX_DESTINATION_RATE/)
    expect(() => createTelnyxOutbound({ apiKey: 'KEY', spendLimits: { maxDestinationRate: 0, dailySpendLimit: 50 } })).toThrow(
      /refusing the spend limits/,
    )
  })

  test('warm transfer from the env: the env spend limits go on the profile', async () => {
    const { calls, fetch } = mockTelnyx(freshAccount())
    await transferOutboundSipFromEnv(
      { TELEPHONY_PROVIDER: 'telnyx', TELNYX_API_KEY: 'KEY', TELNYX_DAILY_SPEND_LIMIT: '30' },
      fetch,
    )
    expect(calls.find(c => c.method === 'POST' && c.path === '/outbound_voice_profiles')?.body).toMatchObject({
      max_destination_rate: 0.1,
      daily_spend_limit: '30.00',
      daily_spend_limit_enabled: true,
    })
  })

  test('refuses to manage objects not named linedesk-*', () => {
    expect(() => createTelnyxOutbound({ apiKey: 'KEY', name: 'OtherCo' })).toThrow(/only objects named linedesk-/)
  })

  test('SIP user names fit Telnyx rules', () => {
    expect(sipUserName('linedesk-test-caller')).toBe('cflinedesktestcaller')
    expect(sipUserName('x'.repeat(60))).toHaveLength(32)
  })
})
