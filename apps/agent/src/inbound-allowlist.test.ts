import { SIPDispatchRuleInfo, SIPInboundTrunkInfo } from '@livekit/protocol'
import { CARRIER_SIGNALING_ADDRESSES } from '@linedesk/telephony'
import { describe, expect, test } from 'vitest'
import { ALLOWED_ADDRESSES_ENV, inboundAllowlistFromEnv, isAddressOrRange, parseInboundAllowlist } from './inbound-allowlist.ts'
import { ensureInboundTrunk, INBOUND_TRUNK_NAME, openInboundWarnings } from './sip-trunks.ts'

const telnyx = CARRIER_SIGNALING_ADDRESSES.telnyx.addresses
const twilio = CARRIER_SIGNALING_ADDRESSES.twilio.addresses

describe('carrier signaling addresses (config contract)', () => {
  test.each(Object.entries(CARRIER_SIGNALING_ADDRESSES))('%s: every entry is an address LiveKit enforces, with a source and a date', (_, carrier) => {
    expect(carrier.addresses.length).toBeGreaterThan(0)
    for (const address of carrier.addresses) expect(isAddressOrRange(address), address).toBe(true)
    expect(new Set(carrier.addresses).size).toBe(carrier.addresses.length)
    expect(carrier.source).toMatch(/^https:\/\//)
    expect(carrier.checked).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  test('the US signaling IPs each carrier sends calls from are in the list', () => {
    expect(telnyx).toEqual(expect.arrayContaining(['192.76.120.10', '64.16.250.10']))
    expect(twilio).toEqual(expect.arrayContaining(['54.172.60.0/30', '54.244.51.0/30']))
  })
})

describe('isAddressOrRange', () => {
  test.each(['192.0.2.10', '192.0.2.0/24', '2001:db8::1', '2001:db8::/32', '10.0.0.0/8', '203.0.113.7/32'])('accepts %s', token => {
    expect(isAddressOrRange(token)).toBe(true)
  })
  // Hostnames would be compared with the caller's own From header; /0 is everything.
  test.each(['sip.telnyx.com', '192.0.2.0/33', '192.0.2.0/', '0.0.0.0/0', '::/0', '192.0.2.0/24/1', '192.0.2', '192.0.2.0/x', '2001:db8::/129', ''])('refuses %s', token => {
    expect(isAddressOrRange(token)).toBe(false)
  })
})

describe('LIVEKIT_SIP_ALLOWED_ADDRESSES', () => {
  test('unset or empty: Telnyx and Twilio', () => {
    for (const env of [{}, { [ALLOWED_ADDRESSES_ENV]: '' }, { [ALLOWED_ADDRESSES_ENV]: '  ' }]) {
      const allowlist = inboundAllowlistFromEnv(env)
      expect(allowlist.addresses).toEqual([...telnyx, ...twilio])
      expect(allowlist.sources).toEqual(['telnyx', 'twilio'])
    }
  })

  test('one carrier, extra addresses, commas or spaces, no duplicates', () => {
    expect(parseInboundAllowlist('telnyx').addresses).toEqual([...telnyx])
    const allowlist = parseInboundAllowlist('Twilio, 203.0.113.7  198.51.100.0/24,203.0.113.7')
    expect(allowlist.addresses).toEqual([...twilio, '203.0.113.7', '198.51.100.0/24'])
    expect(allowlist.sources).toEqual(['twilio', 'custom'])
    expect(parseInboundAllowlist('203.0.113.7').addresses).toEqual(['203.0.113.7'])
  })

  test('"any" alone opens the trunk on purpose; combined it is refused', () => {
    expect(parseInboundAllowlist('any')).toEqual({ addresses: [], sources: ['any'] })
    expect(() => parseInboundAllowlist('any telnyx')).toThrow('cannot be combined')
  })

  test('anything else is refused, never silently dropped', () => {
    expect(() => parseInboundAllowlist('telnyx plivo')).toThrow('"plivo" is not a carrier (telnyx, twilio), "any", or an IP address or CIDR range')
    expect(() => parseInboundAllowlist('sip.telnyx.com')).toThrow('"sip.telnyx.com" is not a carrier')
    expect(() => parseInboundAllowlist('0.0.0.0/0')).toThrow('"0.0.0.0/0"')
    expect(() => parseInboundAllowlist(' , ')).toThrow('lists nothing')
  })
})

/** A stand-in for LiveKit's SipClient that keeps inbound trunks in memory and records every call. */
function fakeSip(initial: SIPInboundTrunkInfo[] = []) {
  let trunks = [...initial]
  let next = 1
  const calls: string[] = []
  return {
    calls,
    trunks: () => trunks,
    async listSipInboundTrunk() {
      return trunks
    },
    async createSipInboundTrunk(name: string, numbers: string[], opts?: { allowedAddresses?: string[] }) {
      calls.push(`create ${name}`)
      const trunk = new SIPInboundTrunkInfo({ sipTrunkId: `ST_new${next++}`, name, numbers, allowedAddresses: opts?.allowedAddresses ?? [] })
      trunks.push(trunk)
      return trunk
    },
    async updateSipInboundTrunkFields(id: string, fields: { numbers?: { set: string[] }; allowedAddresses?: { set: string[]; clear: boolean } }) {
      calls.push(`update ${id}`)
      const trunk = trunks.find(t => t.sipTrunkId === id)!
      if (fields.numbers) trunk.numbers = fields.numbers.set
      if (fields.allowedAddresses) trunk.allowedAddresses = fields.allowedAddresses.clear ? [] : fields.allowedAddresses.set
      return trunk
    },
    async deleteSipTrunk(id: string) {
      calls.push(`delete ${id}`)
      trunks = trunks.filter(t => t.sipTrunkId !== id)
      return new SIPInboundTrunkInfo()
    },
  }
}

describe('ensureInboundTrunk', () => {
  const numbers = ['+15035550142']

  test('creates the trunk with the address list when it is missing', async () => {
    const sip = fakeSip()
    const id = await ensureInboundTrunk(sip as never, numbers, ['192.0.2.10'])
    expect(sip.calls).toEqual(['create linedesk-inbound'])
    expect(sip.trunks()).toMatchObject([{ sipTrunkId: id, name: INBOUND_TRUNK_NAME, numbers, allowedAddresses: ['192.0.2.10'] }])
  })

  test('an open trunk from before is restricted in place: same id, nothing deleted', async () => {
    const sip = fakeSip([new SIPInboundTrunkInfo({ sipTrunkId: 'ST_old', name: INBOUND_TRUNK_NAME, numbers: ['+15035550100'] })])
    const id = await ensureInboundTrunk(sip as never, numbers, [...telnyx])
    expect(id).toBe('ST_old')
    expect(sip.calls).toEqual(['update ST_old'])
    expect(sip.trunks()).toMatchObject([{ sipTrunkId: 'ST_old', numbers, allowedAddresses: [...telnyx] }])
  })

  test('running it again changes nothing but the lists', async () => {
    const sip = fakeSip()
    const first = await ensureInboundTrunk(sip as never, numbers, ['192.0.2.10'])
    const second = await ensureInboundTrunk(sip as never, numbers, ['192.0.2.10'])
    expect(second).toBe(first)
    expect(sip.trunks()).toHaveLength(1)
  })

  test('"any" clears the list; duplicates of the name are removed; other trunks are left alone', async () => {
    const sip = fakeSip([
      new SIPInboundTrunkInfo({ sipTrunkId: 'ST_a', name: INBOUND_TRUNK_NAME, allowedAddresses: ['192.0.2.10'] }),
      new SIPInboundTrunkInfo({ sipTrunkId: 'ST_b', name: INBOUND_TRUNK_NAME }),
      new SIPInboundTrunkInfo({ sipTrunkId: 'ST_other', name: 'someone-else' }),
    ])
    expect(await ensureInboundTrunk(sip as never, numbers, [])).toBe('ST_a')
    expect(sip.calls).toEqual(['delete ST_b', 'update ST_a'])
    expect(sip.trunks().map(t => [t.sipTrunkId, t.allowedAddresses])).toEqual([['ST_a', []], ['ST_other', []]])
  })
})

test('openInboundWarnings names open trunks and rules bound to no trunk, not ours', () => {
  const trunks = [
    new SIPInboundTrunkInfo({ sipTrunkId: 'ST_ours', name: INBOUND_TRUNK_NAME }),
    new SIPInboundTrunkInfo({ sipTrunkId: 'ST_open', name: 'old-pbx' }),
    new SIPInboundTrunkInfo({ sipTrunkId: 'ST_ips', name: 'pbx-ips', allowedAddresses: ['192.0.2.10'] }),
    new SIPInboundTrunkInfo({ sipTrunkId: 'ST_auth', name: 'pbx-auth', authUsername: 'u' }),
  ]
  const rules = [
    new SIPDispatchRuleInfo({ sipDispatchRuleId: 'SDR_ours', name: INBOUND_TRUNK_NAME, trunkIds: ['ST_ours'] }),
    new SIPDispatchRuleInfo({ sipDispatchRuleId: 'SDR_any', name: 'catch-all' }),
  ]
  expect(openInboundWarnings(trunks, rules)).toEqual([
    'inbound trunk ST_open ("old-pbx") accepts calls from any address',
    'dispatch rule SDR_any ("catch-all") is bound to no trunk, so it also takes calls from addresses no trunk allows',
  ])
})
