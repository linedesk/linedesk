// Contract: every provider behaves the same through TelephonyProvider. Telnyx runs against mocked HTTP.
import { generateKeyPairSync, sign } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { describeProviderContract } from './contract.ts'
import { createTelnyxProvider, devNoFreeAreaCodes, devProvider, installCarrierName, telephonyProviderFromEnv, TelephonyError } from './index.ts'
import { telnyxLineType } from './telnyx.ts'

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

type Account = { owned?: boolean; connection?: boolean; routedTo?: string | null; fqdns?: { id: string; connection_id: string; fqdn: string }[]; screening?: string }

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
  if (method === 'GET' && path === '/phone_numbers/num_1/voice') return { json: { data: { inbound_call_screening: account.screening ?? 'disabled' } } }
  if (method === 'PATCH' && path === '/phone_numbers/num_1/voice') {
    account.screening = body.inbound_call_screening
    return { json: { data: { inbound_call_screening: account.screening } } }
  }
  if (method === 'GET' && path === '/phone_numbers/num_1') return { json: { data: { id: 'num_1', connection_id: account.routedTo ?? null } } }
  if (method === 'PATCH' && path === '/phone_numbers/num_1') {
    account.routedTo = body.connection_id
    return { json: { data: { id: 'num_1' } } }
  }
  if (method === 'GET' && path.startsWith('/number_lookup/')) {
    return { json: { data: { phone_number: path.split('/')[2]!.split('?')[0], carrier: { name: 'T-Mobile USA, Inc.', type: 'mobile' }, portability: { line_type: 'wireless' } } } }
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

test('dev has no free number in the area codes LINEDESK_DEV_NO_FREE_AREA_CODES names, and numbers everywhere else', async () => {
  expect(devNoFreeAreaCodes('')).toEqual([])
  expect(devNoFreeAreaCodes(' 416, 212 ,')).toEqual(['416', '212'])
  vi.stubEnv('LINEDESK_DEV_NO_FREE_AREA_CODES', '416')
  try {
    expect(await devProvider.searchNumbers({ country: 'CA', areaCode: '416', limit: 5 })).toEqual([])
    expect(await devProvider.searchNumbers({ country: 'CA', areaCode: '647', limit: 1 })).toEqual([{ e164: '+16475550100' }])
  } finally {
    vi.unstubAllEnvs()
  }
})

describe('telnyx number lookup', () => {
  test('asks Number Lookup for the carrier part and reads line type and carrier name', async () => {
    const { provider, calls } = mockTelnyx(telnyxAccount())
    expect(await provider.lookupNumber('+15035550142')).toEqual({ e164: '+15035550142', lineType: 'mobile', carrier: 'T-Mobile USA, Inc.' })
    expect(calls).toEqual([{ method: 'GET', path: '/number_lookup/+15035550142?type=carrier', body: undefined, auth: 'Bearer KEY' }])
  })

  test('falls back to the portability data, and says unknown when nothing fits', async () => {
    const landline = mockTelnyx(() => ({ json: { data: { carrier: { name: '', type: null }, portability: { line_type: 'landline', spid_carrier_name: 'Comcast Phone' } } } }))
    expect(await landline.provider.lookupNumber('+15035550142')).toEqual({ e164: '+15035550142', lineType: 'landline', carrier: 'Comcast Phone' })
    const empty = mockTelnyx(() => ({ json: { data: {} } }))
    expect(await empty.provider.lookupNumber('+15035550142')).toEqual({ e164: '+15035550142', lineType: 'unknown', carrier: null })
  })

  test('"fixed line or mobile" says nothing about the line: unknown', () => {
    expect(['fixed line or mobile', 'mobile', 'fixed line', 'VoIP'].map(telnyxLineType)).toEqual(['unknown', 'mobile', 'landline', 'voip'])
  })

  test('a refused lookup is a TelephonyError', async () => {
    const { provider } = mockTelnyx(() => ({ status: 403, json: { errors: [{ detail: 'Number Lookup is not enabled' }] } }))
    await expect(provider.lookupNumber('+15035550142')).rejects.toThrow(TelephonyError)
  })
})
describeProviderContract('telnyx', () => {
  const account = telnyxAccount()
  return mockTelnyx(account).provider
})

describe('telnyx adapter', () => {
  test('a request Telnyx never answers fails after the timeout, without holding the caller', async () => {
    const seen: (AbortSignal | null | undefined)[] = []
    const hung: typeof fetch = (_url, init) => {
      seen.push(init?.signal)
      return new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason)))
    }
    const provider = createTelnyxProvider({ apiKey: 'KEY', fetch: hung, timeoutMs: 20 })
    const failed = await provider.searchNumbers({ country: 'US', areaCode: '503', limit: 1 }).catch(e => e)
    expect(failed).toBeInstanceOf(TelephonyError)
    expect(failed.message).toMatch(/GET \/available_phone_numbers: Telnyx did not answer within 0.02 s/)
    expect(failed.message).not.toContain('KEY')
    expect(seen[0]).toBeInstanceOf(AbortSignal)
  })

  test('an answer whose body never finishes fails after the timeout too', async () => {
    const slowBody: typeof fetch = async (_url, init) => new Response(new ReadableStream({
      start(controller) {
        init?.signal?.addEventListener('abort', () => controller.error(init.signal!.reason))
      },
    }), { status: 200 })
    const provider = createTelnyxProvider({ apiKey: 'KEY', fetch: slowBody, timeoutMs: 20 })
    await expect(provider.findNumber(NUMBER)).rejects.toThrow(/did not answer within/)
  })

  test('searches voice numbers by country and area code', async () => {
    const { provider, calls } = mockTelnyx(telnyxAccount())
    const numbers = await provider.searchNumbers({ country: 'US', areaCode: '503', limit: 5 })
    expect(numbers).toEqual([{ e164: NUMBER, locality: 'PORTLAND', region: 'OR', monthlyCost: '1.00', currency: 'USD' }])
    expect(calls[0]!.path).toBe('/available_phone_numbers?filter[country_code]=US&filter[features][]=voice&filter[limit]=5&filter[best_effort]=false&filter[national_destination_code]=503')
    expect(calls[0]!.auth).toBe('Bearer KEY')
  })

  test('searches Canada and Puerto Rico by their own country code, after checking Telnyx asks nothing for them', async () => {
    for (const [country, areaCode] of [['CA', '416'], ['PR', '787']] as const) {
      const { provider, calls } = mockTelnyx(c =>
        c.path.startsWith('/regulatory_requirements') ? { json: { data: [{ country_code: country, phone_number_type: 'local', action: 'ordering', regulatory_requirements: [] }] } } : telnyxAccount()(c),
      )
      expect(await provider.searchNumbers({ country, areaCode, limit: 5 })).toHaveLength(1)
      expect(calls.map(c => c.path)).toEqual([
        `/regulatory_requirements?filter[country_code]=${country}&filter[phone_number_type]=local&filter[action]=ordering`,
        `/available_phone_numbers?filter[country_code]=${country}&filter[features][]=voice&filter[limit]=5&filter[best_effort]=false&filter[national_destination_code]=${areaCode}`,
      ])
    }
  })

  test('a country whose local numbers need an address or documents is refused before any search or order', async () => {
    const { provider, calls } = mockTelnyx(c =>
      c.path.startsWith('/regulatory_requirements')
        ? { json: { data: [{ country_code: 'CA', regulatory_requirements: [{ name: 'Address matching the DID area code', field_type: 'address_id' }, { field_type: 'document_id' }] }] } }
        : telnyxAccount()(c),
    )
    const refused = provider.searchNumbers({ country: 'CA', areaCode: '416' })
    await expect(refused).rejects.toThrow(
      'telnyx: local numbers in CA need Address matching the DID area code, document_id at Telnyx, which Linedesk cannot submit yet',
    )
    // The app tells this in its own words: the requirement names stay in the log.
    await expect(refused).rejects.toMatchObject({ code: 'country_requirements' })
    expect(calls.map(c => c.path.split('?')[0])).toEqual(['/regulatory_requirements'])
  })

  test('a requirements check that fails at Telnyx fails the search, nothing is searched or ordered', async () => {
    const { provider, calls } = mockTelnyx(c =>
      c.path.startsWith('/regulatory_requirements') ? { status: 500, json: { errors: [{ detail: 'Internal error' }] } } : telnyxAccount()(c),
    )
    const failed = provider.searchNumbers({ country: 'PR', areaCode: '787' })
    await expect(failed).rejects.toThrow(/^telnyx: /)
    await expect(failed).rejects.toMatchObject({ status: 500, code: undefined })
    expect(calls.map(c => c.path.split('?')[0])).toEqual(['/regulatory_requirements'])
  })

  test('only the row for local numbers and ordering in the country counts: porting rules do not refuse a purchase', async () => {
    const { provider, calls } = mockTelnyx(c =>
      c.path.startsWith('/regulatory_requirements')
        ? { json: { data: [
            { country_code: 'CA', phone_number_type: 'local', action: 'porting', regulatory_requirements: [{ name: 'Letter of authorization', field_type: 'document' }] },
            { country_code: 'CA', phone_number_type: 'toll_free', action: 'ordering', regulatory_requirements: [{ name: 'Address', field_type: 'address' }] },
            { country_code: 'CA', phone_number_type: 'local', action: 'ordering', regulatory_requirements: [] },
          ] } }
        : telnyxAccount()(c),
    )
    expect(await provider.searchNumbers({ country: 'CA', areaCode: '416', limit: 5 })).toHaveLength(1)
    expect(calls.map(c => c.path.split('?')[0])).toEqual(['/regulatory_requirements', '/available_phone_numbers'])
  })

  describe('a search that finds nothing', () => {
    let warnings: string[]
    beforeEach(() => {
      warnings = []
      vi.spyOn(console, 'warn').mockImplementation((message: unknown) => void warnings.push(String(message)))
    })
    afterEach(() => vi.restoreAllMocks())

    const searchAnswers = (answer: { status?: number; json: unknown }) =>
      mockTelnyx(c =>
        c.path.startsWith('/regulatory_requirements') ? { json: { data: [] } }
          : c.path.startsWith('/available_phone_numbers') ? answer
            : telnyxAccount()(c),
      )

    test('Telnyx answers an area code without free numbers with HTTP 400 (10031): an empty search, in the log', async () => {
      const { provider, calls } = searchAnswers({ status: 400, json: { errors: [{ code: '10031', title: 'Invalid request filter', detail: 'No numbers found for the given filters' }] } })
      expect(await provider.searchNumbers({ country: 'CA', areaCode: '416', limit: 5 })).toEqual([])
      expect(calls.map(c => c.path.split('?')[0])).toEqual(['/regulatory_requirements', '/available_phone_numbers'])
      expect(warnings).toEqual(['telnyx: no number found for CA area code 416: No numbers found for the given filters (10031)'])
    })

    test('no coverage in the country (10015) is an empty search too', async () => {
      const { provider } = searchAnswers({ status: 400, json: { errors: [{ code: 10015, detail: 'No coverage found in the specified country' }] } })
      expect(await provider.searchNumbers({ country: 'PR', areaCode: '787' })).toEqual([])
      expect(warnings).toEqual(['telnyx: no number found for PR area code 787: No coverage found in the specified country (10015)'])
    })

    test('any other 400 with those codes stays an error', async () => {
      for (const errors of [
        [{ code: '10031', detail: 'The request filter filter[foo] is invalid.' }],
        [{ code: '10015', detail: 'The request failed because it was not well-formed.' }],
        [{ code: '10031', detail: 'No numbers found for the given filters' }, { code: '10005', detail: 'Resource not found' }],
      ]) {
        const { provider } = searchAnswers({ status: 400, json: { errors } })
        await expect(provider.searchNumbers({ country: 'CA', areaCode: '416' })).rejects.toMatchObject({ status: 400, code: undefined })
      }
      expect(warnings).toEqual([])
    })

    test('best-effort results (numbers near the area code, not in it) are never offered', async () => {
      const { provider, calls } = searchAnswers({ json: { data: [
        { phone_number: '+16475550100', best_effort: true },
        { phone_number: '+14165550100', best_effort: false },
      ] } })
      expect((await provider.searchNumbers({ country: 'CA', areaCode: '416' })).map(n => n.e164)).toEqual(['+14165550100'])
      expect(calls[1]!.path).toContain('filter[best_effort]=false')
    })
  })

  test('a US search asks for no requirements', async () => {
    const { provider, calls } = mockTelnyx(telnyxAccount())
    await provider.searchNumbers({ country: 'US', areaCode: '503' })
    expect(calls.map(c => c.path.split('?')[0])).toEqual(['/available_phone_numbers'])
  })

  describe('an order that does not complete is cancelled, with an ALERT for the operator', () => {
    let alerts: string[]
    beforeEach(() => {
      alerts = []
      vi.spyOn(console, 'error').mockImplementation((message: unknown) => void alerts.push(String(message)))
    })
    afterEach(() => vi.restoreAllMocks())

    const order = (extra: Record<string, unknown>) => ({ json: { data: { id: 'order_2', status: 'pending', sub_number_orders_ids: ['sub_1'], ...extra } } })

    test('waiting for regulatory requirements: its sub-order is cancelled at once, the error is not_activated', async () => {
      const { provider, calls } = mockTelnyx(c =>
        c.path === '/number_orders' ? order({ requirements_met: false }) : c.path === '/sub_number_orders/sub_1/cancel' ? { json: { data: { id: 'sub_1', status: 'cancelled' } } } : { json: { data: [] } },
      )
      const bought = provider.buyNumber('+14165550100')
      await expect(bought).rejects.toThrow('telnyx: number order order_2 for +14165550100 waits for regulatory requirements (address or documents)')
      await expect(bought).rejects.toMatchObject({ code: 'not_activated' })
      expect(calls.map(c => `${c.method} ${c.path}`)).toEqual(['POST /number_orders', 'PATCH /sub_number_orders/sub_1/cancel'])
      expect(alerts).toEqual(['ALERT number order order_2 for +14165550100 waits for regulatory requirements (address or documents) at Telnyx; it was cancelled'])
    })

    test('a cancel that fails is in the ALERT, with what the operator does', async () => {
      const { provider } = mockTelnyx(c =>
        c.path === '/number_orders' ? order({ requirements_met: false }) : c.path.startsWith('/sub_number_orders') ? { status: 422, json: { errors: [{ detail: 'Order cannot be cancelled' }] } } : { json: { data: [] } },
      )
      await expect(provider.buyNumber('+17875550100')).rejects.toMatchObject({ code: 'not_activated' })
      expect(alerts).toHaveLength(1)
      expect(alerts[0]).toMatch(/^ALERT number order order_2 for \+17875550100 waits for regulatory requirements .* cancelling it failed \(.*Order cannot be cancelled.*\): cancel it in the Telnyx portal, or release \+17875550100 once it is on the account$/)
    })

    test('still pending after the lookups: cancelled; one that completed meanwhile is bought after all', async () => {
      const stuck = mockTelnyx(c => (c.path === '/number_orders' ? order({}) : { json: { data: [] } }))
      await expect(stuck.provider.buyNumber(NUMBER)).rejects.toMatchObject({ code: 'not_activated', message: `telnyx: number order order_2 for ${NUMBER} is still pending` })
      expect(stuck.calls.filter(c => c.method === 'PATCH').map(c => c.path)).toEqual(['/sub_number_orders/sub_1/cancel'])
      expect(alerts).toEqual([`ALERT number order order_2 for ${NUMBER} is still pending at Telnyx; it was cancelled`])

      let cancelled = false
      const late = mockTelnyx(c => {
        if (c.path === '/number_orders') return order({})
        if (c.method === 'PATCH') {
          cancelled = true
          return { status: 422, json: { errors: [{ detail: 'Order already completed' }] } }
        }
        return { json: { data: cancelled ? [{ id: 'num_9', phone_number: NUMBER }] : [] } }
      })
      expect(await late.provider.buyNumber(NUMBER)).toEqual({ e164: NUMBER, providerRef: 'num_9' })
    })

    test('an order without sub-orders cannot be cancelled here: the ALERT says so', async () => {
      const { provider, calls } = mockTelnyx(c => (c.path === '/number_orders' ? { json: { data: { id: 'order_3', status: 'pending', requirements_met: false } } } : { json: { data: [] } }))
      await expect(provider.buyNumber('+14165550100')).rejects.toMatchObject({ code: 'not_activated' })
      expect(calls.map(c => c.path)).toEqual(['/number_orders'])
      expect(alerts).toEqual(['ALERT number order order_3 for +14165550100 waits for regulatory requirements (address or documents) at Telnyx; it has no sub-order to cancel: cancel it in the Telnyx portal'])
    })
  })

  test('buys a number with an order and returns the phone number id', async () => {
    const { provider, calls } = mockTelnyx(telnyxAccount())
    expect(await provider.buyNumber(NUMBER)).toEqual({ e164: NUMBER, providerRef: 'num_1' })
    expect(calls.map(c => `${c.method} ${c.path.split('?')[0]}`)).toEqual(['POST /number_orders', 'GET /phone_numbers'])
    expect(calls[0]!.body).toEqual({ phone_numbers: [{ phone_number: NUMBER }] })
    expect(calls[1]!.path).toBe(`/phone_numbers?filter[phone_number]=${NUMBER}`)
  })

  test('a German number is searched with the install\'s requirements and ordered with its requirement group (LIN-619)', async () => {
    const { provider, calls } = mockTelnyx(telnyxAccount())
    await provider.searchNumbers({ country: 'DE', areaCode: '6221', limit: 5, withRequirements: true })
    expect(calls.map(c => c.path)).toEqual([
      '/available_phone_numbers?filter[country_code]=DE&filter[features][]=voice&filter[limit]=5&filter[best_effort]=false&filter[national_destination_code]=6221',
    ])
    await provider.buyNumber(NUMBER, { requirementGroupRef: 'rg_1' })
    expect(calls.find(c => c.path === '/number_orders')!.body).toEqual({ phone_numbers: [{ phone_number: NUMBER, requirement_group_id: 'rg_1' }] })
  })

  test('a national number (Germany 032) is searched by its type, without an area code', async () => {
    const { provider, calls } = mockTelnyx(telnyxAccount())
    await provider.searchNumbers({ country: 'DE', limit: 5, withRequirements: true, numberType: 'national' })
    expect(calls[0]!.path).toContain('filter[phone_number_type]=national')
    expect(calls[0]!.path).not.toContain('national_destination_code')
  })

  test('the dev carrier gives a national number the area code 32, and none when 32 has no free number', async () => {
    expect((await devProvider.searchNumbers({ country: 'DE', numberType: 'national', limit: 1 }))[0]!.e164).toMatch(/^\+4932/)
  })

  test('findNumber looks the number up and never orders', async () => {
    const owned = mockTelnyx(telnyxAccount({ owned: true }))
    expect(await owned.provider.findNumber(NUMBER)).toEqual({ e164: NUMBER, providerRef: 'num_1' })
    const missing = mockTelnyx(telnyxAccount())
    expect(await missing.provider.findNumber(NUMBER)).toBeNull()
    expect([...owned.calls, ...missing.calls].every(c => c.method === 'GET')).toBe(true)
  })

  test('findNumber takes only the exact number, never a partial match of the filter', async () => {
    const partial = mockTelnyx(c =>
      c.method === 'GET' && c.path.startsWith('/phone_numbers?')
        ? { json: { data: [{ id: 'num_other', phone_number: `${NUMBER}9` }, { id: 'num_shorter', phone_number: NUMBER.slice(0, -1) }] } }
        : undefined,
    )
    expect(await partial.provider.findNumber(NUMBER)).toBeNull()
    expect(await partial.provider.findNumber(NUMBER.slice(0, -1))).toEqual({ e164: NUMBER.slice(0, -1), providerRef: 'num_shorter' })
  })

  test('fails when the order fails or never completes', async () => {
    const failed = mockTelnyx(c => c.path === '/number_orders' ? { json: { data: { id: 'order_1', status: 'failure' } } } : { json: { data: [] } })
    await expect(failed.provider.buyNumber(NUMBER)).rejects.toThrow('number order order_1 for +15035550100 failed')
    const pending = mockTelnyx(c => c.path === '/number_orders' ? { json: { data: { id: 'order_1', status: 'pending' } } } : { json: { data: [] } })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(pending.provider.buyNumber(NUMBER)).rejects.toThrow(`number order order_1 for ${NUMBER} is still pending`)
    vi.restoreAllMocks()
  })

  const routed = { e164: NUMBER, providerRef: 'num_1' }
  const steps = (calls: Call[]) => calls.map(c => `${c.method} ${c.path.split('?')[0]}`)

  test('creates the LiveKit connection and FQDN once, then points the number at it', async () => {
    const account: Account = { owned: true }
    const first = mockTelnyx(telnyxAccount(account))
    await first.provider.routeToSip(routed, SIP)
    expect(steps(first.calls)).toEqual([
      'GET /fqdn_connections', 'POST /fqdn_connections', 'GET /fqdns', 'POST /fqdns', 'PATCH /phone_numbers/num_1',
      'GET /phone_numbers/num_1/voice', 'PATCH /phone_numbers/num_1/voice',
    ])
    expect(first.calls[1]!.body).toMatchObject({ connection_name: 'linedesk-livekit', transport_protocol: 'TCP', inbound: { dnis_number_format: '+e164' } })
    expect(first.calls[3]!.body).toEqual({ connection_id: 'conn_1', fqdn: SIP, port: 5060, dns_record_type: 'a' })
    expect(first.calls[4]!.body).toEqual({ connection_id: 'conn_1' })
    expect(first.calls[6]!.body).toEqual({ inbound_call_screening: 'flag_calls' })
    expect(account.screening).toBe('flag_calls')

    const second = mockTelnyx(telnyxAccount(account))
    await second.provider.routeToSip(routed, SIP)
    expect(steps(second.calls)).toEqual(['GET /fqdn_connections', 'GET /fqdns', 'PATCH /phone_numbers/num_1', 'GET /phone_numbers/num_1/voice'])
  })

  test('LINEDESK_CARRIER_SUFFIX names the connection per install, so a second install in the account never repoints the first', async () => {
    process.env.LINEDESK_CARRIER_SUFFIX = 'prod'
    try {
      const { provider, calls } = mockTelnyx(telnyxAccount({ owned: true }))
      await provider.routeToSip(routed, SIP)
      expect(calls[1]!.body).toMatchObject({ connection_name: 'linedesk-livekit-prod' })
    } finally {
      delete process.env.LINEDESK_CARRIER_SUFFIX
    }
    expect(installCarrierName('linedesk-outbound', '')).toBe('linedesk-outbound')
    expect(() => installCarrierName('linedesk-livekit', 'Prod!')).toThrow('LINEDESK_CARRIER_SUFFIX')
  })

  test('recognises its FQDN when Telnyx sends the connection id as a number too large for JSON', async () => {
    const BIG_ID = '3090231229346219988'
    const account: Account = { owned: true }
    const big = mockTelnyx(call => {
      if (call.method === 'GET' && call.path.startsWith('/fqdn_connections'))
        return { json: { data: [{ id: BIG_ID, connection_name: 'linedesk-livekit' }] } }
      // As Telnyx sends it: a bare number, which JSON.parse rounds.
      if (call.method === 'GET' && call.path.startsWith('/fqdns?'))
        return { json: { data: [{ id: 'fqdn_1', connection_id: Number(BIG_ID), fqdn: SIP }] } }
      return telnyxAccount(account)(call)
    })
    await big.provider.routeToSip(routed, SIP)
    expect(steps(big.calls)).toEqual(['GET /fqdn_connections', 'GET /fqdns', 'PATCH /phone_numbers/num_1', 'GET /phone_numbers/num_1/voice', 'PATCH /phone_numbers/num_1/voice'])
    expect(big.calls[2]!.body).toEqual({ connection_id: BIG_ID })
  })

  test('repairs a connection that has no FQDN and replaces a changed endpoint', async () => {
    const account: Account = { owned: true, connection: true }
    await mockTelnyx(telnyxAccount(account)).provider.routeToSip(routed, SIP)
    expect(account.fqdns).toEqual([{ id: `fqdn_${SIP}`, connection_id: 'conn_1', fqdn: SIP }])

    const moved = mockTelnyx(telnyxAccount(account))
    await moved.provider.routeToSip(routed, 'sip.new.test')
    expect(account.fqdns?.map(f => f.fqdn)).toEqual(['sip.new.test'])
    expect(steps(moved.calls)).toEqual(['GET /fqdn_connections', 'GET /fqdns', 'POST /fqdns', `DELETE /fqdns/fqdn_${SIP}`, 'PATCH /phone_numbers/num_1', 'GET /phone_numbers/num_1/voice'])
  })

  test("spam screening in flag mode: turned on when off, an owner's own choice kept, a failure never fails routing", async () => {
    const off: Account = { owned: true, connection: true }
    await mockTelnyx(telnyxAccount(off)).provider.routeToSip(routed, SIP)
    expect(off.screening).toBe('flag_calls')
    const rejecting: Account = { owned: true, connection: true, screening: 'reject_calls' }
    await mockTelnyx(telnyxAccount(rejecting)).provider.routeToSip(routed, SIP)
    expect(rejecting.screening).toBe('reject_calls')
    const account: Account = { owned: true, connection: true }
    const base = telnyxAccount(account)
    const refused = mockTelnyx(c => (c.path.endsWith('/voice') ? { status: 403, json: { errors: [{ detail: 'no' }] } } : base(c)))
    await expect(refused.provider.routeToSip(routed, SIP)).resolves.toBeUndefined()
    expect(account.routedTo).toBe('conn_1')
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
    // Signed, but the timestamp is not a number: NaN would pass a plain tolerance check.
    expect(() => provider.parseWebhook(signedWebhook(event, 'soon' as unknown as number))).toThrow('not a number')
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

describe('telnyx requirement groups (LIN-623): read only', () => {
  const GROUP_ID = '015b6441-3931-4a2b-9bfd-0da5d092bda1'
  const group = (status = 'pending-approval') => ({
    data: {
      id: GROUP_ID,
      country_code: 'DE',
      phone_number_type: 'local',
      action: 'ordering',
      status,
      record_type: 'requirement_group',
      regulatory_requirements: [
        { requirement_id: 'req_name', field_type: 'textual', field_value: 'Linedesk', status: 'approved' },
        { requirement_id: 'req_addr', field_type: 'address', field_value: 'addr_1', status: 'pending-approval' },
      ],
    },
  })
  const address = {
    data: {
      id: 'addr_1',
      street_address: 'Musterstraße 1',
      extended_address: '',
      locality: 'Dossenheim',
      postal_code: '69221',
      country_code: 'DE',
    },
  }
  const groups: Route = ({ method, path }) => {
    if (method === 'GET' && path === `/requirement_groups/${GROUP_ID}`) return { json: group() }
    if (method === 'GET' && path === '/addresses/addr_1') return { json: address }
    return undefined
  }

  test('reads the group, its status, its address and the portal link, with GETs only and the key only in the header', async () => {
    const { provider, calls } = mockTelnyx(groups)
    expect(await provider.requirementGroup!(GROUP_ID)).toEqual({
      id: GROUP_ID,
      country: 'DE',
      numberType: 'local',
      action: 'ordering',
      status: 'pending-approval',
      address: { street: 'Musterstraße 1', postalCode: '69221', city: 'Dossenheim', country: 'DE' },
      portalUrl: `https://portal.telnyx.com/#/numbers/requirements/requirement-groups/edit/${GROUP_ID}`,
    })
    expect(calls.map(c => `${c.method} ${c.path}`)).toEqual([
      `GET /requirement_groups/${GROUP_ID}`,
      'GET /addresses/addr_1',
    ])
    expect(calls.every(c => c.auth === 'Bearer KEY')).toBe(true)
  })

  test('a group Telnyx does not know is null; an address that cannot be read leaves only the address out', async () => {
    const { provider } = mockTelnyx(() => undefined)
    expect(await provider.requirementGroup!('rg_missing')).toBeNull()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const noAddress = mockTelnyx(c =>
      c.path.startsWith('/addresses') ? { status: 500, json: { errors: [{ detail: 'down' }] } } : groups(c),
    )
    expect(await noAddress.provider.requirementGroup!(GROUP_ID)).toMatchObject({
      status: 'pending-approval',
      address: null,
    })
    warn.mockRestore()
  })

  test('another failure is thrown, with the status and never the key', async () => {
    const { provider } = mockTelnyx(() => ({ status: 401, json: { errors: [{ detail: 'Authentication failed' }] } }))
    const error = await provider.requirementGroup!(GROUP_ID).catch(e => e)
    expect(error).toMatchObject({ status: 401 })
    expect(String(error.message)).not.toContain('KEY')
  })

  /** Telnyx's stock: Dossenheim's numbers are filed under 06221; an area code filter matches exactly. */
  const stock =
    (exact = true): Route =>
    ({ method, path }) => {
      if (method !== 'GET' || !path.startsWith('/available_phone_numbers?')) return undefined
      const query = new URLSearchParams(path.split('?')[1])
      const numbers = ['+4962217234160', '+4962217234161']
      if (query.get('filter[locality]') === 'Dossenheim')
        return { json: { data: numbers.map(phone_number => ({ phone_number })) } }
      const code = query.get('filter[national_destination_code]')
      if (code && (exact ? code === '6221' : '62217234'.startsWith(code)))
        return { json: { data: [{ phone_number: numbers[0] }] } }
      if (code) return { status: 400, json: { errors: [{ code: '10031', detail: 'No numbers found' }] } }
      return { status: 400, json: { errors: [{ code: '10031', detail: 'No numbers found' }] } }
    }

  test('the area code of a town: the one prefix of its numbers that is an area code (06221 for Dossenheim)', async () => {
    const { provider, calls } = mockTelnyx(stock())
    expect(await provider.localAreaCode!('DE', 'Dossenheim')).toBe('6221')
    expect(calls.every(c => c.method === 'GET')).toBe(true)
    expect(calls[0]!.path).toContain('filter[locality]=Dossenheim')
    expect(calls[0]!.path).toContain('filter[phone_number_type]=local')
  })

  test('not sure is null: a town without stock, an area code filter that matches loosely, a country other than DE', async () => {
    expect(await mockTelnyx(stock()).provider.localAreaCode!('DE', 'Kleinhausen')).toBeNull()
    expect(await mockTelnyx(stock(false)).provider.localAreaCode!('DE', 'Dossenheim')).toBeNull()
    const other = mockTelnyx(stock())
    expect(await other.provider.localAreaCode!('US', 'Portland')).toBeNull()
    expect(other.calls).toEqual([])
  })
})

describe('dev requirement groups', () => {
  test('a word in the id picks the state, for trying every state without a carrier', async () => {
    expect(await devProvider.requirementGroup!('rg_ok')).toMatchObject({ status: 'approved', country: 'DE' })
    expect(await devProvider.requirementGroup!('rg_pending')).toMatchObject({ status: 'pending-approval' })
    expect(await devProvider.requirementGroup!('rg_missing')).toBeNull()
    await expect(devProvider.requirementGroup!('rg_fail')).rejects.toBeInstanceOf(TelephonyError)
    expect(await devProvider.localAreaCode!('DE', 'Dossenheim')).toBe('6221')
    expect(await devProvider.localAreaCode!('DE', 'Kleinhausen')).toBeNull()
  })
})
