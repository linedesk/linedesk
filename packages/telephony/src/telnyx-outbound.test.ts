// Telnyx outbound setup against mocked HTTP: only objects named for the call test are touched.
import { describe, expect, test } from 'vitest'
import { createTelnyxOutbound, sipUserName, transferOutboundSipFromEnv } from './index.ts'

type Call = { method: string; path: string; body?: Record<string, unknown> }
type Account = {
  profiles: { id: string; name: string }[]
  connections: { id: string; connection_name: string }[]
  numbers: { id: string; phone_number: string; connection_id: string | null }[]
  /** Telnyx keeps another destination list than the one sent. */
  ignoresWhitelist?: boolean
}

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
      return ok({ ...account.profiles.at(-1), whitelisted_destinations: body.whitelisted_destinations })
    }
    if (method === 'GET' && path.startsWith('/credential_connections')) return ok(account.connections)
    if (method === 'POST' && path === '/credential_connections') {
      account.connections.push({ id: 'conn_test', connection_name: body.connection_name })
      return ok(account.connections.at(-1))
    }
    if (method === 'PATCH' && path.startsWith('/credential_connections/')) return ok({ id: path.split('/')[2] })
    if (method === 'PATCH' && path.startsWith('/outbound_voice_profiles/'))
      return ok({ id: path.split('/')[2], whitelisted_destinations: account.ignoresWhitelist ? ['US', 'CA'] : body.whitelisted_destinations })
    if (method === 'GET' && path.startsWith('/phone_numbers?')) return ok(account.numbers.filter(n => path.endsWith(n.phone_number)))
    if (method === 'PATCH' && path.startsWith('/phone_numbers/')) {
      const number = account.numbers.find(n => path.endsWith(n.id))!
      number.connection_id = body.connection_id
      return ok(number)
    }
    return Response.json({ errors: [{ detail: `no mock for ${method} ${path}` }] }, { status: 404 })
  }
  return { outbound: createTelnyxOutbound({ apiKey: 'KEY', fetch: fakeFetch }), calls, fetch: fakeFetch }
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
    })
    const again = mockTelnyx(account)
    await again.outbound.ensureOutboundSip(CALLER)
    expect(again.calls.find(c => c.method === 'PATCH' && c.path === '/outbound_voice_profiles/ovp_1')?.body).toEqual({ whitelisted_destinations: ['US'] })
  })

  test('fails closed when Telnyx does not keep the profile to the US', async () => {
    const account = { ...freshAccount(), ignoresWhitelist: true }
    await mockTelnyx(account).outbound.ensureOutboundSip(CALLER)
    await expect(mockTelnyx(account).outbound.ensureOutboundSip(CALLER)).rejects.toThrow(/not limited to US destinations/)
  })

  test('refuses to manage objects not named linedesk-*', () => {
    expect(() => createTelnyxOutbound({ apiKey: 'KEY', name: 'OtherCo' })).toThrow(/only objects named linedesk-/)
  })

  test('SIP user names fit Telnyx rules', () => {
    expect(sipUserName('linedesk-test-caller')).toBe('cflinedesktestcaller')
    expect(sipUserName('x'.repeat(60))).toHaveLength(32)
  })
})
