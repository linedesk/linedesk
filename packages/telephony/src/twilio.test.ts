// Twilio adapter against mocked HTTP: no request ever leaves the process.
import { createHmac } from 'node:crypto'
import { describe, expect, test } from 'vitest'
import { describeProviderContract } from './contract.ts'
import { createTwilioProvider, TelephonyError, twilioLineType } from './index.ts'

type Call = { method: string; host: string; path: string; form?: Record<string, string>; auth: string }
type Account = {
  numbers?: { sid: string; phone_number: string }[]
  trunks?: { sid: string; friendly_name: string }[]
  originations?: { sid: string; sip_url: string }[]
  attached?: string[]
}

const NUMBER = '+15035550100'
const SIP = 'sip.linedesk.test'
const ACCOUNT = '/2010-04-01/Accounts/AC1'
const TOKEN = 'auth-token'

/** A Twilio account in memory. `fail` makes one request return an error. */
function mockTwilio(
  account: Account = {},
  fail?: (call: Call) => { status: number; message: string } | undefined,
  auth: { authToken: string } | { apiKeySid: string; apiKeySecret: string } = { authToken: TOKEN },
) {
  const calls: Call[] = []
  const state = { numbers: [], trunks: [], originations: [], attached: [], ...account } as Required<Account>
  const fakeFetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input))
    const headers = init!.headers as Record<string, string>
    const form = init!.body ? Object.fromEntries(new URLSearchParams(String(init!.body))) : undefined
    const call: Call = { method: init!.method!, host: url.host, path: url.pathname + url.search, form, auth: headers.authorization! }
    calls.push(call)
    const failure = fail?.(call)
    if (failure) return Response.json({ code: 20000, message: failure.message }, { status: failure.status })
    const { method } = call
    const path = url.pathname
    const json = (body: unknown, status = 200) => Response.json(body, { status })

    if (method === 'GET' && /^\/2010-04-01\/Accounts\/AC1\/AvailablePhoneNumbers\/(US|CA|PR)\/Local\.json$/.test(path)) {
      return json({ available_phone_numbers: [{ phone_number: NUMBER, locality: 'Portland', region: 'OR' }] })
    }
    if (method === 'GET' && path === `${ACCOUNT}/IncomingPhoneNumbers.json`) {
      const wanted = url.searchParams.get('PhoneNumber')
      return json({ incoming_phone_numbers: state.numbers.filter(n => !wanted || n.phone_number === wanted) })
    }
    if (method === 'POST' && path === `${ACCOUNT}/IncomingPhoneNumbers.json`) {
      state.numbers.push({ sid: 'PN1', phone_number: form!.PhoneNumber! })
      return json(state.numbers.at(-1), 201)
    }
    if (method === 'DELETE' && path === `${ACCOUNT}/IncomingPhoneNumbers/PN1.json`) {
      state.numbers = state.numbers.filter(n => n.sid !== 'PN1')
      return new Response(null, { status: 204 })
    }
    if (method === 'GET' && url.host === 'lookups.twilio.com' && path.startsWith('/v2/PhoneNumbers/')) {
      return json({ phone_number: decodeURIComponent(path.split('/')[3]!), line_type_intelligence: { type: 'mobile', carrier_name: 'AT&T Wireless' } })
    }
    if (method === 'GET' && path === '/v1/Trunks') return json({ trunks: state.trunks })
    if (method === 'POST' && path === '/v1/Trunks') {
      state.trunks.push({ sid: 'TK1', friendly_name: form!.FriendlyName! })
      return json(state.trunks.at(-1), 201)
    }
    if (method === 'GET' && path === '/v1/Trunks/TK1/OriginationUrls') return json({ origination_urls: state.originations })
    if (method === 'POST' && path === '/v1/Trunks/TK1/OriginationUrls') {
      state.originations.push({ sid: `OU${state.originations.length + 1}`, sip_url: form!.SipUrl! })
      return json(state.originations.at(-1), 201)
    }
    if (method === 'DELETE' && path.startsWith('/v1/Trunks/TK1/OriginationUrls/')) {
      state.originations = state.originations.filter(o => !path.endsWith(`/${o.sid}`))
      return new Response(null, { status: 204 })
    }
    if (method === 'GET' && path === '/v1/Trunks/TK1/PhoneNumbers') return json({ phone_numbers: state.attached.map(sid => ({ sid })) })
    if (method === 'DELETE' && path.startsWith('/v1/Trunks/TK1/PhoneNumbers/')) {
      state.attached = state.attached.filter(sid => !path.endsWith(`/${sid}`))
      return new Response(null, { status: 204 })
    }
    if (method === 'POST' && path === '/v1/Trunks/TK1/PhoneNumbers') {
      state.attached.push(form!.PhoneNumberSid!)
      return json({ sid: form!.PhoneNumberSid }, 201)
    }
    return json({ code: 20404, message: `no mock for ${method} ${path}` }, 404)
  }
  const provider = createTwilioProvider({ accountSid: 'AC1', ...auth, fetch: fakeFetch })
  return { provider, calls, state }
}

const steps = (calls: Call[]) => calls.map(c => `${c.method} ${c.path.split('?')[0]!.replace(ACCOUNT, '')}`)
const routed = { e164: NUMBER, providerRef: 'PN1' }

describeProviderContract('twilio', () => mockTwilio().provider)
describeProviderContract('twilio with an API key', () => mockTwilio({}, undefined, { apiKeySid: 'SK1', apiKeySecret: 'key-secret' }).provider)

describe('twilio lookup', () => {
  test('asks Lookup v2 for line type intelligence and reads type and carrier', async () => {
    const { provider, calls } = mockTwilio()
    expect(await provider.lookupNumber('+15035550142')).toEqual({ e164: '+15035550142', lineType: 'mobile', carrier: 'AT&T Wireless' })
    expect(calls.at(-1)).toMatchObject({ method: 'GET', host: 'lookups.twilio.com', path: '/v2/PhoneNumbers/%2B15035550142?Fields=line_type_intelligence' })
  })

  test('VoIP types read as voip; a refused lookup is a TelephonyError', async () => {
    expect(['fixedVoip', 'nonFixedVoip', 'tollFree', 'pager'].map(twilioLineType)).toEqual(['voip', 'voip', 'toll_free', 'unknown'])
    const { provider } = mockTwilio({}, call => (call.host === 'lookups.twilio.com' ? { status: 401, message: 'Authenticate' } : undefined))
    await expect(provider.lookupNumber('+15035550142')).rejects.toThrow(TelephonyError)
  })

  test('a lookup Twilio never answers fails after the timeout', async () => {
    const hung: typeof fetch = (_url, init) => new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason)))
    const provider = createTwilioProvider({ accountSid: 'AC1', authToken: TOKEN, fetch: hung, timeoutMs: 20 })
    const failed = await provider.lookupNumber('+15035550142').catch(e => e)
    expect(failed).toBeInstanceOf(TelephonyError)
    expect(failed.message).toMatch(/look up line type: Twilio did not answer within 0.02 s/)
  })
})

describe('twilio adapter', () => {
  test('searches local voice numbers by country and area code, with basic auth', async () => {
    const { provider, calls } = mockTwilio()
    expect(await provider.searchNumbers({ country: 'US', areaCode: '503', limit: 5 })).toEqual([{ e164: NUMBER, locality: 'Portland', region: 'OR' }])
    expect(calls[0]).toMatchObject({ host: 'api.twilio.com', path: `${ACCOUNT}/AvailablePhoneNumbers/US/Local.json?VoiceEnabled=true&PageSize=5&AreaCode=503` })
    expect(calls[0]!.auth).toBe(`Basic ${Buffer.from(`AC1:${TOKEN}`).toString('base64')}`)
  })

  test('a national number (Germany 032) is refused before Twilio is asked: it needs a requirement group', async () => {
    const { provider, calls } = mockTwilio()
    await expect(provider.searchNumbers({ country: 'DE', numberType: 'national' })).rejects.toMatchObject({ code: 'country_requirements' })
    expect(calls).toEqual([])
  })

  test('searches Canada and Puerto Rico under their own country code (no address needed for local numbers there)', async () => {
    const { provider, calls } = mockTwilio()
    for (const [country, areaCode] of [['CA', '416'], ['PR', '787']] as const) {
      expect(await provider.searchNumbers({ country, areaCode, limit: 5 })).toHaveLength(1)
      expect(calls.at(-1)!.path).toBe(`${ACCOUNT}/AvailablePhoneNumbers/${country}/Local.json?VoiceEnabled=true&PageSize=5&AreaCode=${areaCode}`)
    }
  })

  test('an API key authenticates as the key, in the account given by its SID', async () => {
    const { provider, calls } = mockTwilio({ numbers: [{ sid: 'PN1', phone_number: NUMBER }] }, undefined, { apiKeySid: 'SK1', apiKeySecret: 'key-secret' })
    expect(await provider.listNumbers(20)).toEqual([routed])
    expect(calls[0]).toMatchObject({ method: 'GET', path: `${ACCOUNT}/IncomingPhoneNumbers.json?PageSize=20` })
    expect(calls[0]!.auth).toBe(`Basic ${Buffer.from('SK1:key-secret').toString('base64')}`)
  })

  test('with an API key, webhooks are refused: Twilio signs them with the auth token', () => {
    const { provider } = mockTwilio({}, undefined, { apiKeySid: 'SK1', apiKeySecret: 'key-secret' })
    expect(() => provider.parseWebhook({ url: 'https://x.test', rawBody: 'CallSid=CA1', headers: { 'x-twilio-signature': 'AAAA' } })).toThrow('auth token')
  })

  test('buyNumber buys', async () => {
    const { provider, calls } = mockTwilio()
    expect(await provider.buyNumber(NUMBER)).toEqual({ e164: NUMBER, providerRef: 'PN1' })
    expect(steps(calls)).toEqual(['POST /IncomingPhoneNumbers.json'])
    expect(calls[0]!.form).toEqual({ PhoneNumber: NUMBER })
  })

  test('findNumber returns a number of the account and never buys', async () => {
    const owned = mockTwilio({ numbers: [{ sid: 'PN1', phone_number: NUMBER }] })
    expect(await owned.provider.findNumber(NUMBER)).toEqual({ e164: NUMBER, providerRef: 'PN1' })
    const missing = mockTwilio()
    expect(await missing.provider.findNumber(NUMBER)).toBeNull()
    expect([...owned.calls, ...missing.calls].every(c => c.method === 'GET')).toBe(true)
  })

  test('creates trunk and origination URI once, then attaches the number', async () => {
    const first = mockTwilio({ numbers: [{ sid: 'PN1', phone_number: NUMBER }] })
    await first.provider.routeToSip(routed, SIP)
    expect(steps(first.calls)).toEqual([
      'GET /v1/Trunks', 'POST /v1/Trunks', 'GET /v1/Trunks/TK1/OriginationUrls', 'POST /v1/Trunks/TK1/OriginationUrls',
      'GET /v1/Trunks/TK1/PhoneNumbers', 'POST /v1/Trunks/TK1/PhoneNumbers',
    ])
    expect(first.calls[1]).toMatchObject({ host: 'trunking.twilio.com', form: { FriendlyName: 'linedesk-livekit' } })
    expect(first.calls[3]!.form).toEqual({ FriendlyName: 'LiveKit SIP', SipUrl: `sip:${SIP};transport=tcp`, Weight: '1', Priority: '1', Enabled: 'true' })
    expect(first.calls[5]!.form).toEqual({ PhoneNumberSid: 'PN1' })

    const again = mockTwilio(first.state)
    await again.provider.routeToSip(routed, SIP)
    expect(again.calls.every(c => c.method === 'GET')).toBe(true)
  })

  test('repairs a trunk without origination URI and replaces a changed endpoint', async () => {
    const { provider, state, calls } = mockTwilio({ trunks: [{ sid: 'TK1', friendly_name: 'linedesk-livekit' }], originations: [{ sid: 'OU1', sip_url: 'sip:old.test;transport=tcp' }] })
    await provider.routeToSip(routed, SIP)
    expect(state.originations).toEqual([{ sid: 'OU2', sip_url: `sip:${SIP};transport=tcp` }])
    expect(steps(calls)).toContain('DELETE /v1/Trunks/TK1/OriginationUrls/OU1')
    expect(state.attached).toEqual(['PN1'])
  })

  test('a failed step fails routing; the next run completes it', async () => {
    const account: Account = {}
    const broken = mockTwilio(account, c => (c.method === 'POST' && c.path.endsWith('/OriginationUrls') ? { status: 500, message: 'boom' } : undefined))
    await expect(broken.provider.routeToSip(routed, SIP)).rejects.toThrow('boom')
    expect(broken.state.attached).toEqual([])

    const fixed = mockTwilio(broken.state)
    await fixed.provider.routeToSip(routed, SIP)
    expect(fixed.state.originations.map(o => o.sip_url)).toEqual([`sip:${SIP};transport=tcp`])
    expect(fixed.state.attached).toEqual(['PN1'])
    expect(fixed.state.trunks).toHaveLength(1)
  })

  test('releases a number', async () => {
    const { provider, calls, state } = mockTwilio({ numbers: [{ sid: 'PN1', phone_number: NUMBER }] })
    await provider.releaseNumber(routed)
    expect(steps(calls)).toEqual(['DELETE /IncomingPhoneNumbers/PN1.json'])
    expect(state.numbers).toEqual([])
  })

  test('API errors carry the status and the message from Twilio', async () => {
    const { provider } = mockTwilio({}, () => ({ status: 401, message: 'Authenticate' }))
    const error = await provider.searchNumbers({ country: 'US' }).catch(e => e)
    expect(error).toBeInstanceOf(TelephonyError)
    expect(error).toMatchObject({ status: 401, message: 'twilio: search numbers failed: Authenticate' })
    for (const secret of [TOKEN, 'AC1', '/Accounts/']) expect(error.message).not.toContain(secret)
  })

  const url = 'https://api.linedesk.test/v1/webhooks/telephony?source=twilio'
  const fields = { CallSid: 'CA1', CallStatus: 'completed', From: '+15035550191', To: NUMBER, Timestamp: 'Tue, 10 Nov 2026 10:00:00 +0000' }
  function signed(form: Record<string, string>, signedUrl = url) {
    const text = Object.keys(form).sort().reduce((all, key) => all + key + form[key], signedUrl)
    const signature = createHmac('sha1', TOKEN).update(text).digest('base64')
    return { url, rawBody: new URLSearchParams(form).toString(), headers: { 'x-twilio-signature': signature } }
  }

  test('parses a signed status webhook', () => {
    const { provider } = mockTwilio()
    expect(provider.parseWebhook(signed(fields))).toEqual({
      id: 'CA1:completed', status: 'hangup', providerEventType: 'completed', from: '+15035550191', to: NUMBER, occurredAt: '2026-11-10T10:00:00.000Z',
    })
    expect(provider.parseWebhook(signed({ ...fields, CallStatus: 'ringing' })).status).toBe('initiated')
    expect(provider.parseWebhook(signed({ ...fields, CallStatus: 'in-progress' })).status).toBe('answered')
    expect(provider.parseWebhook(signed({ ...fields, CallStatus: 'something-new' })).status).toBeNull()
    expect(provider.parseWebhook(signed({ ...fields, Timestamp: 'not a date' })).occurredAt).toBeUndefined()
    const { Timestamp: _none, ...withoutTimestamp } = fields
    expect(provider.parseWebhook(signed(withoutTimestamp)).occurredAt).toBeUndefined()
  })

  test('rejects tampered, unsigned and wrongly addressed webhooks', () => {
    const { provider } = mockTwilio()
    const good = signed(fields)
    expect(() => provider.parseWebhook({ ...good, rawBody: good.rawBody.replace('completed', 'ringing') })).toThrow('signature is not valid')
    expect(() => provider.parseWebhook({ ...good, headers: {} })).toThrow('no signature header')
    expect(() => provider.parseWebhook({ ...good, headers: { 'x-twilio-signature': 'AAAA' } })).toThrow('signature is not valid')
    expect(() => provider.parseWebhook(signed(fields, 'https://evil.test/hook'))).toThrow('signature is not valid')
    expect(() => provider.parseWebhook({ ...good, url: undefined })).toThrow('webhook URL is needed')
  })

  test('unroutes a number from Linedesk\'s trunk only, and never creates one', async () => {
    const { provider, calls, state } = mockTwilio({ trunks: [{ sid: 'TK1', friendly_name: 'linedesk-livekit' }], attached: ['PN1', 'PN2'] })
    await provider.unrouteNumber(routed)
    expect(steps(calls)).toEqual(['GET /v1/Trunks', 'GET /v1/Trunks/TK1/PhoneNumbers', 'DELETE /v1/Trunks/TK1/PhoneNumbers/PN1'])
    expect(state.attached).toEqual(['PN2'])

    const none = mockTwilio()
    await none.provider.unrouteNumber(routed)
    expect(steps(none.calls)).toEqual(['GET /v1/Trunks'])
  })
})
