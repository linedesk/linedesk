// Telnyx outbound setup against mocked HTTP: only objects named for the call test are touched.
import { describe, expect, test } from 'vitest'
import { createTelnyxOutbound, sipUserName } from './index.ts'

type Call = { method: string; path: string; body?: Record<string, unknown> }
type Account = {
  profiles: { id: string; name: string }[]
  connections: { id: string; connection_name: string }[]
  numbers: { id: string; phone_number: string; connection_id: string | null }[]
}

const CALLER = '+15035550192'

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
      return ok(account.profiles.at(-1))
    }
    if (method === 'GET' && path.startsWith('/credential_connections')) return ok(account.connections)
    if (method === 'POST' && path === '/credential_connections') {
      account.connections.push({ id: 'conn_test', connection_name: body.connection_name })
      return ok(account.connections.at(-1))
    }
    if (method === 'PATCH' && path.startsWith('/credential_connections/')) return ok({ id: path.split('/')[2] })
    if (method === 'GET' && path.startsWith('/phone_numbers?')) return ok(account.numbers.filter(n => path.endsWith(n.phone_number)))
    if (method === 'PATCH' && path.startsWith('/phone_numbers/')) {
      const number = account.numbers.find(n => path.endsWith(n.id))!
      number.connection_id = body.connection_id
      return ok(number)
    }
    return Response.json({ errors: [{ detail: `no mock for ${method} ${path}` }] }, { status: 404 })
  }
  return { outbound: createTelnyxOutbound({ apiKey: 'KEY', fetch: fakeFetch }), calls }
}

const freshAccount = (): Account => ({
  profiles: [{ id: 'ovp_other', name: 'OtherCo' }],
  connections: [{ id: 'conn_other', connection_name: 'OtherCo' }],
  numbers: [{ id: 'num_b', phone_number: CALLER, connection_id: null }, { id: 'num_other', phone_number: '+15035550100', connection_id: 'conn_other' }],
})

describe('telnyx outbound for the call test', () => {
  test('creates profile and connection, attaches the caller number, returns trunk settings', async () => {
    const account = freshAccount()
    const { outbound, calls } = mockTelnyx(account)
    const sip = await outbound.ensureOutboundSip(CALLER)
    expect(sip).toMatchObject({ address: 'sip.telnyx.com', username: 'cfcallfronttestcaller', headers: { 'X-Telnyx-Username': 'cfcallfronttestcaller' } })
    expect(sip.password.length).toBeGreaterThanOrEqual(20)
    const created = calls.find(c => c.method === 'POST' && c.path === '/credential_connections')!
    expect(created.body).toMatchObject({ connection_name: 'callfront-test-caller', user_name: 'cfcallfronttestcaller', password: sip.password, outbound: { outbound_voice_profile_id: 'ovp_1' } })
    expect(account.numbers.find(n => n.id === 'num_b')?.connection_id).toBe('conn_test')
  })

  test('a second run reuses both and only sets a new password', async () => {
    const account = freshAccount()
    await mockTelnyx(account).outbound.ensureOutboundSip(CALLER)
    const { outbound, calls } = mockTelnyx(account)
    const again = await outbound.ensureOutboundSip(CALLER)
    expect(calls.filter(c => c.method === 'POST')).toEqual([])
    expect(calls.find(c => c.method === 'PATCH')).toMatchObject({ path: '/credential_connections/conn_test', body: { password: again.password } })
  })

  test('never touches objects with another name, such as the OtherCo connection', async () => {
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

  test('SIP user names fit Telnyx rules', () => {
    expect(sipUserName('callfront-test-caller')).toBe('cfcallfronttestcaller')
    expect(sipUserName('x'.repeat(60))).toHaveLength(32)
  })
})
