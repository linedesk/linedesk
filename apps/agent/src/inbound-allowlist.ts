// Which source addresses LiveKit SIP takes inbound calls from (allowedAddresses of the linedesk-inbound
// trunk). LIVEKIT_SIP_ALLOWED_ADDRESSES lists carrier names (their published signaling addresses, see
// @linedesk/telephony's CARRIER_SIGNALING_ADDRESSES) and/or IPs and CIDR ranges, separated by spaces or
// commas; unset or empty: "telnyx twilio". "any" alone turns the restriction off (anyone reaching 5060 can call).
import { isIP } from 'node:net'
import { CARRIER_SIGNALING_ADDRESSES, type SignalingCarrier } from '@linedesk/telephony'

export const ALLOWED_ADDRESSES_ENV = 'LIVEKIT_SIP_ALLOWED_ADDRESSES'
export const DEFAULT_ALLOWED_ADDRESSES = 'telnyx twilio'

/** `addresses` empty means open: LiveKit accepts calls from any source. */
export interface InboundAllowlist {
  addresses: string[]
  /** What the list is made of, for the log line: carrier names and "custom". */
  sources: string[]
}

const isCarrier = (token: string): token is SignalingCarrier => Object.hasOwn(CARRIER_SIGNALING_ADDRESSES, token)

/**
 * An IPv4/IPv6 address or CIDR range. LiveKit silently drops entries it cannot parse (and an entry that is
 * not an IP is compared with the caller's From host, which anyone can set), so only these get through.
 * /0 is refused: an open trunk is written as "any", on purpose.
 */
export function isAddressOrRange(token: string): boolean {
  const [address, bits, ...rest] = token.split('/')
  const version = isIP(address ?? '')
  if (!version || rest.length) return false
  if (bits === undefined) return true
  if (!/^\d{1,3}$/.test(bits)) return false
  const prefix = Number(bits)
  return prefix >= 1 && prefix <= (version === 4 ? 32 : 128)
}

/** Parses the setting; throws naming the first entry that is neither a carrier, "any" nor an address. */
export function parseInboundAllowlist(setting: string): InboundAllowlist {
  const tokens = setting.split(/[\s,]+/).filter(Boolean)
  if (!tokens.length) throw new Error(`${ALLOWED_ADDRESSES_ENV} lists nothing; leave it empty for "${DEFAULT_ALLOWED_ADDRESSES}", or set "any" to accept calls from anywhere`)
  if (tokens.includes('any')) {
    if (tokens.length > 1) throw new Error(`${ALLOWED_ADDRESSES_ENV}: "any" accepts every address, so it cannot be combined with others`)
    return { addresses: [], sources: ['any'] }
  }
  const addresses = new Set<string>()
  const sources = new Set<string>()
  for (const token of tokens) {
    const name = token.toLowerCase()
    if (isCarrier(name)) {
      for (const address of CARRIER_SIGNALING_ADDRESSES[name].addresses) addresses.add(address)
      sources.add(name)
    } else if (isAddressOrRange(token)) {
      addresses.add(token)
      sources.add('custom')
    } else {
      const carriers = Object.keys(CARRIER_SIGNALING_ADDRESSES).join(', ')
      throw new Error(`${ALLOWED_ADDRESSES_ENV}: "${token}" is not a carrier (${carriers}), "any", or an IP address or CIDR range`)
    }
  }
  return { addresses: [...addresses], sources: [...sources] }
}

export function inboundAllowlistFromEnv(env: Record<string, string | undefined> = process.env): InboundAllowlist {
  return parseInboundAllowlist(env[ALLOWED_ADDRESSES_ENV]?.trim() || DEFAULT_ALLOWED_ADDRESSES)
}
