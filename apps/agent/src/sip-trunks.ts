// LiveKit SIP outbound trunks, by name: one for the phone call test ("linedesk-test-caller") and one
// for warm transfers ("linedesk-outbound"). Each goes through the carrier's credentials (OutboundSip).
import { SIPTransport } from '@livekit/protocol'
import { TRANSFER_OUTBOUND_NAME, type OutboundSip } from '@linedesk/telephony'
import { SipClient } from 'livekit-server-sdk'
import { livekitHttpUrl, requireLivekitEnv } from './env.ts'

export const OUTBOUND_TRUNK_NAME = 'linedesk-test-caller'
export const TRANSFER_TRUNK_NAME = TRANSFER_OUTBOUND_NAME

export function sipClient() {
  const env = requireLivekitEnv()
  return new SipClient(livekitHttpUrl(env.LIVEKIT_URL), env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET)
}

/** Replaces the outbound trunk of that name with one for these credentials and caller-ID numbers; returns its id. */
export async function replaceOutboundTrunk(
  sip: SipClient,
  numbers: string[],
  outbound: OutboundSip,
  name = OUTBOUND_TRUNK_NAME,
): Promise<string> {
  for (const trunk of await sip.listSipOutboundTrunk())
    if (trunk.name === name) await sip.deleteSipTrunk(trunk.sipTrunkId)
  const trunk = await sip.createSipOutboundTrunk(name, outbound.address, numbers, {
    transport: SIPTransport.SIP_TRANSPORT_TCP,
    authUsername: outbound.username,
    authPassword: outbound.password,
    headers: outbound.headers,
  })
  return trunk.sipTrunkId
}

export async function findOutboundTrunk(sip: SipClient, name = OUTBOUND_TRUNK_NAME): Promise<string | null> {
  return (await sip.listSipOutboundTrunk()).find(trunk => trunk.name === name)?.sipTrunkId ?? null
}
