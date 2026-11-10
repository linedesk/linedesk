// The LiveKit side of outbound test calls: one SIP outbound trunk through Telnyx, by name.
import { SIPTransport } from '@livekit/protocol'
import type { OutboundSip } from '@callfront/telephony'
import { SipClient } from 'livekit-server-sdk'
import { livekitHttpUrl, requireLivekitEnv } from '../env.ts'

export const OUTBOUND_TRUNK_NAME = 'callfront-test-caller'

export function sipClient() {
  const env = requireLivekitEnv()
  return new SipClient(livekitHttpUrl(env.LIVEKIT_URL), env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET)
}

/** Replaces the outbound trunk with one for these credentials; returns its id. */
export async function replaceOutboundTrunk(sip: SipClient, callerE164: string, outbound: OutboundSip): Promise<string> {
  for (const trunk of await sip.listSipOutboundTrunk()) if (trunk.name === OUTBOUND_TRUNK_NAME) await sip.deleteSipTrunk(trunk.sipTrunkId)
  const trunk = await sip.createSipOutboundTrunk(OUTBOUND_TRUNK_NAME, outbound.address, [callerE164], {
    transport: SIPTransport.SIP_TRANSPORT_TCP,
    authUsername: outbound.username,
    authPassword: outbound.password,
    headers: outbound.headers,
  })
  return trunk.sipTrunkId
}

export async function findOutboundTrunk(sip: SipClient): Promise<string | null> {
  return (await sip.listSipOutboundTrunk()).find(trunk => trunk.name === OUTBOUND_TRUNK_NAME)?.sipTrunkId ?? null
}
