// Twilio outbound SIP against mocked HTTP: no request ever leaves the process.
import { describe, expect, test } from 'vitest'
import { createTwilioOutbound, TelephonyError, twilioBlockedCountries } from './index.ts'

const SID = `AC${'1'.repeat(32)}`
const ACCOUNT = `/2010-04-01/Accounts/${SID}`

type State = {
  trunks: { sid: string; friendly_name: string; domain_name: string | null }[]
  lists: { sid: string; friendly_name: string }[]
  credentials: { sid: string; username: string; password: string }[]
  attached: string[]
}
type Call = { method: string; path: string; form?: Record<string, string>; auth: string }

function mockTwilio(initial: Partial<State> = {}) {
  const state: State = { trunks: [], lists: [], credentials: [], attached: [], ...initial }
  const calls: Call[] = []
  const fakeFetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input))
    const form = init?.body ? Object.fromEntries(new URLSearchParams(String(init.body))) : undefined
    const call = {
      method: init?.method ?? 'GET',
      path: url.pathname,
      form,
      auth: ((init?.headers ?? {}) as Record<string, string>).authorization ?? '',
    }
    calls.push(call)
    const json = (body: unknown, status = 200) => Response.json(body, { status })
    const { method, path } = call
    if (method === 'GET' && path === '/v1/Trunks') return json({ trunks: state.trunks })
    if (method === 'POST' && path === '/v1/Trunks') {
      state.trunks.push({ sid: 'TK9', friendly_name: form!.FriendlyName!, domain_name: form!.DomainName ?? null })
      return json(state.trunks.at(-1), 201)
    }
    if (method === 'POST' && path.startsWith('/v1/Trunks/') && path.split('/').length === 4) {
      const trunk = state.trunks.find(t => path.endsWith(t.sid))!
      trunk.domain_name = form!.DomainName!
      return json(trunk)
    }
    if (method === 'GET' && path === `${ACCOUNT}/SIP/CredentialLists.json`)
      return json({ credential_lists: state.lists })
    if (method === 'POST' && path === `${ACCOUNT}/SIP/CredentialLists.json`) {
      state.lists.push({ sid: 'CL1', friendly_name: form!.FriendlyName! })
      return json(state.lists.at(-1), 201)
    }
    if (method === 'GET' && path === `${ACCOUNT}/SIP/CredentialLists/CL1/Credentials.json`) {
      return json({ credentials: state.credentials.map(({ sid, username }) => ({ sid, username })) })
    }
    if (method === 'POST' && path === `${ACCOUNT}/SIP/CredentialLists/CL1/Credentials.json`) {
      state.credentials.push({ sid: 'CR1', username: form!.Username!, password: form!.Password! })
      return json({ sid: 'CR1' }, 201)
    }
    if (method === 'POST' && path === `${ACCOUNT}/SIP/CredentialLists/CL1/Credentials/CR1.json`) {
      state.credentials[0]!.password = form!.Password!
      return json({ sid: 'CR1' })
    }
    if (method === 'GET' && path.endsWith('/CredentialLists') && path.startsWith('/v1/Trunks/'))
      return json({ credential_lists: state.attached.map(sid => ({ sid })) })
    if (method === 'POST' && path.endsWith('/CredentialLists') && path.startsWith('/v1/Trunks/')) {
      state.attached.push(form!.CredentialListSid!)
      return json({}, 201)
    }
    return json({ message: `no mock for ${method} ${path}` }, 404)
  }
  return { state, calls, fakeFetch }
}

describe('twilio outbound SIP', () => {
  test('creates the trunk with a termination domain, the credential list and its user, and links them', async () => {
    const { state, calls, fakeFetch } = mockTwilio()
    const sip = await createTwilioOutbound({
      accountSid: SID,
      apiKeySid: `SK${'2'.repeat(32)}`,
      apiKeySecret: 'secret',
      fetch: fakeFetch,
    }).ensureOutboundSip()
    expect(sip.address).toMatch(/^linedesk-outbound-[0-9a-f]{12}\.pstn\.twilio\.com$/)
    expect(sip.username).toBe('cflinedeskoutbound')
    expect(sip.password).toMatch(/^(?=.*[A-Z])(?=.*[a-z])(?=.*\d).{12,}$/)
    expect(sip.headers).toEqual({})
    expect(state.trunks).toEqual([{ sid: 'TK9', friendly_name: 'linedesk-outbound', domain_name: sip.address }])
    expect(state.lists).toEqual([{ sid: 'CL1', friendly_name: 'linedesk-outbound' }])
    expect(state.credentials).toEqual([{ sid: 'CR1', username: sip.username, password: sip.password }])
    expect(state.attached).toEqual(['CL1'])
    expect(calls.every(c => c.auth === `Basic ${Buffer.from(`SK${'2'.repeat(32)}:secret`).toString('base64')}`)).toBe(
      true,
    )
  })

  test('repeating keeps the trunk, domain and list, and only sets a new password', async () => {
    const first = mockTwilio()
    const options = { accountSid: SID, authToken: 'token', fetch: first.fakeFetch }
    const before = await createTwilioOutbound(options).ensureOutboundSip()
    const again = mockTwilio(first.state)
    const after = await createTwilioOutbound({ ...options, fetch: again.fakeFetch }).ensureOutboundSip()
    expect(after.address).toBe(before.address)
    expect(after.password).not.toBe(before.password)
    expect(again.state.credentials).toEqual([{ sid: 'CR1', username: before.username, password: after.password }])
    expect(again.calls.filter(c => c.method === 'POST').map(c => c.path)).toEqual([
      `${ACCOUNT}/SIP/CredentialLists/CL1/Credentials/CR1.json`,
    ])
  })

  test('a trunk of that name without a termination domain gets one; other trunks are left alone', async () => {
    const { state, fakeFetch } = mockTwilio({
      trunks: [
        { sid: 'TK1', friendly_name: 'someone-else', domain_name: 'other.pstn.twilio.com' },
        { sid: 'TK2', friendly_name: 'linedesk-outbound', domain_name: null },
      ],
    })
    const sip = await createTwilioOutbound({
      accountSid: SID,
      authToken: 'token',
      fetch: fakeFetch,
    }).ensureOutboundSip()
    expect(state.trunks).toEqual([
      { sid: 'TK1', friendly_name: 'someone-else', domain_name: 'other.pstn.twilio.com' },
      { sid: 'TK2', friendly_name: 'linedesk-outbound', domain_name: sip.address },
    ])
  })

  test('refuses names that are not Linedesk objects, and errors never carry a credential', async () => {
    expect(() => createTwilioOutbound({ accountSid: SID, authToken: 'token', name: 'OtherCo' })).toThrow(
      TelephonyError,
    )
    const failing: typeof fetch = async () => Response.json({ message: 'Authenticate' }, { status: 401 })
    const error = await createTwilioOutbound({ accountSid: SID, authToken: 'tok-secret', fetch: failing })
      .ensureOutboundSip()
      .catch(e => e)
    expect(error).toMatchObject({ status: 401, message: 'twilio: list trunks failed: Authenticate' })
    expect(error.message).not.toContain('tok-secret')
    expect(error.message).not.toContain(SID)
  })
})

describe('twilio Geo permissions', () => {
  test('reports the countries whose ordinary numbers the account blocks, and only reads', async () => {
    const calls: { method: string; url: string }[] = []
    const fakeFetch: typeof fetch = async (url, init) => {
      calls.push({ method: init!.method!, url: String(url) })
      const country = String(url).split('/').pop()
      return Response.json({ iso_code: country, low_risk_numbers_enabled: country === 'US' })
    }
    const blocked = await twilioBlockedCountries({ accountSid: 'AC1', authToken: 't', fetch: fakeFetch }, [
      'US',
      'DE',
      'KR',
    ])
    expect(blocked).toEqual(['DE', 'KR'])
    expect(
      calls.every(
        c => c.method === 'GET' && c.url.startsWith('https://voice.twilio.com/v1/DialingPermissions/Countries/'),
      ),
    ).toBe(true)
  })
})
