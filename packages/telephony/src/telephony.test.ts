// Contract: every provider behaves the same through TelephonyProvider. Telnyx runs against mocked HTTP.
import { generateKeyPairSync, sign } from 'node:crypto'
import { describe, expect, test } from 'vitest'
import { describeProviderContract } from './contract.ts'
import { createTelnyxProvider, devProvider, telephonyProviderFromEnv, TelephonyError } from './index.ts'

type Call = { method: string; path: string; body?: any; auth: string }
type Route = (call: Call) => { status?: number; json: unknown } | undefined

const NUMBER = '+15035550100'
const SIP = 'sip.linedesk.test'
const { publicKey, privateKey } = generateKeyPairSync('ed25519')
const rawPublicKey = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64')
const NOW = 1_800_000_000_000

function mockTelnyx(routes: Route) {
  const calls: Call[] = []
  const fakeFetch: typeof fetch = async (url, init) => {
    const headers = init!.headers as Record<string, string>
    const call = { method: init!.method!, path: decodeURIComponent(String(url).replace('https://api.telnyx.com/v2', '')), body: init!.body ? JSON.parse(String(init!.body)) : undefined, auth: headers.authorization! }
    calls.push(call)
    const { status = 200, json } = routes(call) ?? { status: 404, json: { errors: [{ detail: `no mock for ${call.method} ${call.path}` }] } }
    return Response.json(json, { status })
  }
  const provider = createTelnyxProvider({ apiKey: 'KEY', publicKey: rawPublicKey, fetch: fakeFetch, wait: async () => {}, now: () => NOW })
  return { provider, calls }
}

type Account = { owned?: boolean; connection?: boolean; routedTo?: string | null; fqdns?: { id: string; connection_id: string; fqdn: string }[] }

/** A Telnyx account in memory: the order puts the number on the account, connections and FQDNs persist. */
const telnyxAccount = (account: Account = {}): Route => ({ method, path, body }) => {
  if (method === 'GET' && path.startsWith('/available_phone_numbers')) {
    return { json: { data: [{
      phone_number: NUMBER, cost_information: { monthly_cost: '1.00', currency: 'USD' },
      region_information: [{ region_type: 'rate_center', region_name: 'PORTLAND' }, { region_type: 'state', region_name: 'OR' }],
    }] } }
  }
  if (method === 'POST' && path === '/number_orders') {
    account.owned = true
    return { json: { data: { id: 'order_1', status: 'pending' } } }
  }
  if (method === 'GET' && path.startsWith('/phone_numbers?page')) return { json: { data: account.owned ? [{ id: 'num_1', phone_number: NUMBER }] : [] } }
  if (method === 'GET' && path.startsWith('/phone_numbers?')) return { json: { data: account.owned ? [{ id: 'num_1', phone_number: NUMBER }] : [] } }
  if (method === 'GET' && path.startsWith('/fqdn_connections')) return { json: { data: account.connection ? [{ id: 'conn_1', connection_name: 'linedesk-livekit' }] : [] } }
  if (method === 'POST' && path === '/fqdn_connections') {
    account.connection = true
    return { json: { data: { id: 'conn_1' } } }
  }
  if (method === 'GET' && path.startsWith('/fqdns?')) return { json: { data: account.fqdns ?? [] } }
  if (method === 'POST' && path === '/fqdns') {
    account.fqdns = [...(account.fqdns ?? []), { id: `fqdn_${body.fqdn}`, connection_id: body.connection_id, fqdn: body.fqdn }]
    return { json: { data: account.fqdns.at(-1) } }
  }
  if (method === 'DELETE' && path.startsWith('/fqdns/')) {
    account.fqdns = account.fqdns?.filter(f => `/fqdns/${f.id}` !== path)
    return { json: { data: {} } }
  }
  if (method === 'GET' && path === '/phone_numbers/num_1') return { json: { data: { id: 'num_1', connection_id: account.routedTo ?? null } } }
  if (method === 'PATCH' && path === '/phone_numbers/num_1') {
    account.routedTo = body.connection_id
    return { json: { data: { id: 'num_1' } } }
  }
  if (method === 'DELETE' && path === '/phone_numbers/num_1') {
    account.owned = false
    return { json: { data: { id: 'num_1' } } }
  }
}

function signedWebhook(body: object, timestamp = NOW / 1000) {
  const rawBody = JSON.stringify(body)
  const signature = sign(null, Buffer.from(`${timestamp}|${rawBody}`), privateKey).toString('base64')
  return { rawBody, headers: { 'telnyx-timestamp': String(timestamp), 'telnyx-signature-ed25519': signature } }
}

describeProviderContract('dev', () => devProvider)
describeProviderContract('telnyx', () => {
  const account = telnyxAccount()
  return mockTelnyx(account).provider
})

describe('telnyx adapter', () => {
  test('searches voice numbers by country and area code', async () => {
    const { provider, calls } = mockTelnyx(telnyxAccount())
    const numbers = await provider.searchNumbers({ country: 'US', areaCode: '503', limit: 5 })
    expect(numbers).toEqual([{ e164: NUMBER, locality: 'PORTLAND', region: 'OR', monthlyCost: '1.00', currency: 'USD' }])
    expect(calls[0]!.path).toBe('/available_phone_numbers?filter[country_code]=US&filter[features][]=voice&filter[limit]=5&filter[national_destination_code]=503')
    expect(calls[0]!.auth).toBe('Bearer KEY')
  })

  test('buys a number with an order and returns the phone number id', async () => {
    const { provider, calls } = mockTelnyx(telnyxAccount())
    expect(await provider.buyNumber(NUMBER)).toEqual({ e164: NUMBER, providerRef: 'num_1' })
    expect(calls.map(c => `${c.method} ${c.path.split('?')[0]}`)).toEqual(['POST /number_orders', 'GET /phone_numbers'])
    expect(calls[0]!.body).toEqual({ phone_numbers: [{ phone_number: NUMBER }] })
    expect(calls[1]!.path).toBe(`/phone_numbers?filter[phone_number]=${NUMBER}`)
  })

  test('findNumber looks the number up and never orders', async () => {
    const owned = mockTelnyx(telnyxAccount({ owned: true }))
    expect(await owned.provider.findNumber(NUMBER)).toEqual({ e164: NUMBER, providerRef: 'num_1' })
    const missing = mockTelnyx(telnyxAccount())
    expect(await missing.provider.findNumber(NUMBER)).toBeNull()
    expect([...owned.calls, ...missing.calls].every(c => c.method === 'GET')).toBe(true)
  })

  test('fails when the order fails or never completes', async () => {
    const failed = mockTelnyx(c => c.path === '/number_orders' ? { json: { data: { id: 'order_1', status: 'failure' } } } : { json: { data: [] } })
    await expect(failed.provider.buyNumber(NUMBER)).rejects.toThrow('number order order_1 for +15035550100 failed')
    const pending = mockTelnyx(c => c.path === '/number_orders' ? { json: { data: { id: 'order_1', status: 'pending' } } } : { json: { data: [] } })
    await expect(pending.provider.buyNumber(NUMBER)).rejects.toThrow(`still pending at the carrier; set up ${NUMBER} again`)
  })

  const routed = { e164: NUMBER, providerRef: 'num_1' }
  const steps = (calls: Call[]) => calls.map(c => `${c.method} ${c.path.split('?')[0]}`)

  test('creates the LiveKit connection and FQDN once, then points the number at it', async () => {
    const account: Account = { owned: true }
    const first = mockTelnyx(telnyxAccount(account))
    await first.provider.routeToSip(routed, SIP)
    expect(steps(first.calls)).toEqual(['GET /fqdn_connections', 'POST /fqdn_connections', 'GET /fqdns', 'POST /fqdns', 'PATCH /phone_numbers/num_1'])
    expect(first.calls[1]!.body).toMatchObject({ connection_name: 'linedesk-livekit', transport_protocol: 'TCP', inbound: { dnis_number_format: '+e164' } })
    expect(first.calls[3]!.body).toEqual({ connection_id: 'conn_1', fqdn: SIP, port: 5060, dns_record_type: 'a' })
    expect(first.calls[4]!.body).toEqual({ connection_id: 'conn_1' })

    const second = mockTelnyx(telnyxAccount(account))
    await second.provider.routeToSip(routed, SIP)
    expect(steps(second.calls)).toEqual(['GET /fqdn_connections', 'GET /fqdns', 'PATCH /phone_numbers/num_1'])
  })

  test('repairs a connection that has no FQDN and replaces a changed endpoint', async () => {
    const account: Account = { owned: true, connection: true }
    await mockTelnyx(telnyxAccount(account)).provider.routeToSip(routed, SIP)
    expect(account.fqdns).toEqual([{ id: `fqdn_${SIP}`, connection_id: 'conn_1', fqdn: SIP }])

    const moved = mockTelnyx(telnyxAccount(account))
    await moved.provider.routeToSip(routed, 'sip.new.test')
    expect(account.fqdns?.map(f => f.fqdn)).toEqual(['sip.new.test'])
    expect(steps(moved.calls)).toEqual(['GET /fqdn_connections', 'GET /fqdns', 'POST /fqdns', `DELETE /fqdns/fqdn_${SIP}`, 'PATCH /phone_numbers/num_1'])
  })

  test('a failed FQDN request fails routing and the next run completes it', async () => {
    const account: Account = { owned: true }
    const base = telnyxAccount(account)
    const broken = mockTelnyx(c => (c.method === 'POST' && c.path === '/fqdns' ? { status: 500, json: { errors: [{ detail: 'boom' }] } } : base(c)))
    await expect(broken.provider.routeToSip(routed, SIP)).rejects.toThrow('boom')
    expect(broken.calls.some(c => c.method === 'PATCH')).toBe(false)

    await mockTelnyx(base).provider.routeToSip(routed, SIP)
    expect(account.fqdns?.map(f => f.fqdn)).toEqual([SIP])
  })

  test('unroutes a number from Linedesk\'s connection only', async () => {
    const account: Account = { owned: true, connection: true, routedTo: 'conn_1' }
    const ours = mockTelnyx(telnyxAccount(account))
    await ours.provider.unrouteNumber(routed)
    expect(steps(ours.calls)).toEqual(['GET /fqdn_connections', 'GET /phone_numbers/num_1', 'PATCH /phone_numbers/num_1'])
    expect(ours.calls[2]!.body).toEqual({ connection_id: null })
    expect(account.routedTo).toBeNull()

    const elsewhere: Account = { owned: true, connection: true, routedTo: 'conn_other' }
    const other = mockTelnyx(telnyxAccount(elsewhere))
    await other.provider.unrouteNumber(routed)
    expect(other.calls.some(c => c.method === 'PATCH')).toBe(false)
    expect(elsewhere.routedTo).toBe('conn_other')

    // No Linedesk connection on the account: nothing to undo, nothing created.
    const none = mockTelnyx(telnyxAccount({ owned: true, routedTo: 'conn_other' }))
    await none.provider.unrouteNumber(routed)
    expect(steps(none.calls)).toEqual(['GET /fqdn_connections'])
  })

  test('releases a number', async () => {
    const { provider, calls } = mockTelnyx(telnyxAccount())
    await provider.releaseNumber({ e164: NUMBER, providerRef: 'num_1' })
    expect(calls[0]).toMatchObject({ method: 'DELETE', path: '/phone_numbers/num_1' })
  })

  test('API errors carry the status and Telnyx detail', async () => {
    const { provider } = mockTelnyx(() => ({ status: 401, json: { errors: [{ detail: 'Authentication failed' }] } }))
    const error = await provider.searchNumbers({ country: 'US' }).catch(e => e)
    expect(error).toBeInstanceOf(TelephonyError)
    expect(error).toMatchObject({ status: 401, message: expect.stringContaining('Authentication failed') })
  })

  const event = { data: { id: 'evt_1', event_type: 'call.hangup', occurred_at: '2026-11-10T10:00:00Z', payload: { from: '+15035550191', to: NUMBER } } }

  test('parses a signed status webhook', () => {
    const { provider } = mockTelnyx(() => undefined)
    expect(provider.parseWebhook(signedWebhook(event))).toEqual({
      id: 'evt_1', status: 'hangup', providerEventType: 'call.hangup', from: '+15035550191', to: NUMBER, occurredAt: '2026-11-10T10:00:00Z',
    })
    const other = { data: { ...event.data, event_type: 'call.machine.detection.ended' } }
    expect(provider.parseWebhook(signedWebhook(other)).status).toBeNull()
  })

  test('rejects tampered, unsigned and stale webhooks', () => {
    const { provider } = mockTelnyx(() => undefined)
    const signed = signedWebhook(event)
    expect(() => provider.parseWebhook({ ...signed, rawBody: signed.rawBody.replace('hangup', 'answered') })).toThrow('signature is not valid')
    expect(() => provider.parseWebhook({ rawBody: signed.rawBody, headers: {} })).toThrow('no signature headers')
    expect(() => provider.parseWebhook(signedWebhook(event, NOW / 1000 - 600))).toThrow('outside the tolerance')
  })
})

describe('telephonyProviderFromEnv', () => {
  test('is dev unless a carrier is chosen, and names what is missing', () => {
    expect(telephonyProviderFromEnv({}).name).toBe('dev')
    expect(telephonyProviderFromEnv({ TELEPHONY_PROVIDER: '' }).name).toBe('dev')
    expect(telephonyProviderFromEnv({ TELEPHONY_PROVIDER: 'twilio', TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 't' }).name).toBe('twilio')
    expect(() => telephonyProviderFromEnv({ TELEPHONY_PROVIDER: 'twilio', TWILIO_ACCOUNT_SID: 'AC1' })).toThrow('TWILIO_AUTH_TOKEN not set')
    expect(() => telephonyProviderFromEnv({ TELEPHONY_PROVIDER: 'twilio' })).toThrow('TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN not set')
    expect(telephonyProviderFromEnv({ TELEPHONY_PROVIDER: 'telnyx', TELNYX_API_KEY: 'k' }).name).toBe('telnyx')
    expect(() => telephonyProviderFromEnv({ TELEPHONY_PROVIDER: 'telnyx' })).toThrow('TELNYX_API_KEY is not set')
    expect(() => telephonyProviderFromEnv({ TELEPHONY_PROVIDER: 'plivo' })).toThrow('unknown TELEPHONY_PROVIDER')
  })
})
