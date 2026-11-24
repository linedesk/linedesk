// The addresses each carrier sends SIP signaling (the INVITE of an inbound call) from, as the carrier
// publishes them. setup-sip puts them on LiveKit's inbound trunk (allowedAddresses), so LiveKit SIP only
// takes calls from a carrier, not from anyone who can reach port 5060. Check the sources when a carrier
// announces a change and update `checked`; LIVEKIT_SIP_ALLOWED_ADDRESSES overrides the list per install.
// Media (RTP) ranges are not here: LiveKit's allowlist only filters signaling.

export type SignalingCarrier = 'telnyx' | 'twilio'

export interface CarrierSignalingAddresses {
  /** Where the carrier publishes them. */
  source: string
  /** Date the list was last compared with the source (YYYY-MM-DD). */
  checked: string
  /** IPv4/IPv6 addresses or CIDR ranges. */
  addresses: readonly string[]
}

export const CARRIER_SIGNALING_ADDRESSES: Record<SignalingCarrier, CarrierSignalingAddresses> = {
  // Primary and secondary signaling IP of every SIP region (voice.json version 2026-05-25). All regions, not
  // only US: a connection's inbound SIP region can be changed in the portal. The "UAC (SIP Attach)" IPs are
  // left out: they belong to SIP Attach, not to calls Telnyx delivers to an FQDN connection.
  telnyx: {
    source: 'https://sip.telnyx.com/voice.json (also https://sip.telnyx.com)',
    checked: '2026-11-11',
    addresses: [
      '192.76.120.10', '64.16.250.10', // US, sip.telnyx.com
      '185.246.41.140', '185.246.41.141', // EU, sip.telnyx.eu
      '103.115.244.145', '103.115.244.146', // AU, sip.telnyx.com.au
      '192.76.120.31', '64.16.250.13', // CA, sip.telnyx.ca
      '103.115.244.158', '103.115.244.159', // AP (beta), sip.telnyx.asia
      '185.246.42.128', '185.246.42.129', // ME, sip.telnyx.me
    ],
  },
  // Elastic SIP Trunking signaling gateways of every edge (page last modified 2026-03-09). Origination
  // (calls Twilio sends to our origination URI) comes from these; all edges, since a trunk can use any.
  twilio: {
    source: 'https://www.twilio.com/docs/sip-trunking/ip-addresses',
    checked: '2026-11-11',
    addresses: [
      '54.172.60.0/30', // North America, Virginia (us1)
      '54.244.51.0/30', // North America, Oregon (us2)
      '54.171.127.192/30', // Europe, Ireland (ie1)
      '35.156.191.128/30', // Europe, Frankfurt (de1)
      '54.65.63.192/30', // Asia-Pacific, Tokyo (jp1)
      '54.169.127.128/30', // Asia-Pacific, Singapore (sg1)
      '54.252.254.64/30', // Asia-Pacific, Sydney (au1)
      '177.71.206.192/30', // South America, São Paulo (br1)
    ],
  },
}
