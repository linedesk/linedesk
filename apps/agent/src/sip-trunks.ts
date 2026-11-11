// LiveKit SIP trunks, by name. Inbound: "linedesk-inbound", the one trunk carriers deliver calls to,
// limited to the carriers' signaling addresses. Outbound: one for the phone call test
// ("linedesk-test-caller") and one for warm transfers ("linedesk-outbound"), each through the carrier's
// credentials (OutboundSip).
import { ListUpdate, type SIPDispatchRuleInfo, type SIPInboundTrunkInfo, SIPTransport } from '@livekit/protocol'
import { TRANSFER_OUTBOUND_NAME, type OutboundSip } from '@linedesk/telephony'
import { SipClient } from 'livekit-server-sdk'
import { livekitHttpUrl, requireLivekitEnv } from './env.ts'

export const INBOUND_TRUNK_NAME = 'linedesk-inbound'
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

type InboundSip = Pick<SipClient, 'listSipInboundTrunk' | 'createSipInboundTrunk' | 'updateSipInboundTrunkFields' | 'deleteSipTrunk'>

/**
 * Makes the inbound trunk of that name accept exactly these numbers from exactly these source addresses
 * (empty: any address). Updates the trunk in place, so its id and the dispatch rule pointing at it stay and
 * no call is refused while it runs; creates it if missing and deletes extra trunks of the same name.
 * Returns the trunk's id.
 */
export async function ensureInboundTrunk(sip: InboundSip, numbers: string[], allowedAddresses: string[], name = INBOUND_TRUNK_NAME): Promise<string> {
  const [existing, ...duplicates] = (await sip.listSipInboundTrunk()).filter(trunk => trunk.name === name)
  for (const duplicate of duplicates) await sip.deleteSipTrunk(duplicate.sipTrunkId)
  if (!existing) return (await sip.createSipInboundTrunk(name, numbers, { allowedAddresses })).sipTrunkId
  await sip.updateSipInboundTrunkFields(existing.sipTrunkId, {
    numbers: new ListUpdate({ set: numbers }),
    // An empty `set` would leave the list as it is; clearing it is how "any address" is written.
    allowedAddresses: new ListUpdate(allowedAddresses.length ? { set: allowedAddresses } : { clear: true }),
  })
  return existing.sipTrunkId
}

/**
 * Other LiveKit SIP objects that let calls in from anywhere, which the linedesk-inbound allowlist cannot
 * close: inbound trunks with neither an address list nor credentials, and dispatch rules bound to no trunk
 * (LiveKit uses those for calls that match no trunk at all). Warnings only; setup-sip does not touch them.
 */
export function openInboundWarnings(trunks: SIPInboundTrunkInfo[], rules: SIPDispatchRuleInfo[], ownName = INBOUND_TRUNK_NAME): string[] {
  const openTrunks = trunks
    .filter(trunk => trunk.name !== ownName && !trunk.allowedAddresses.length && !trunk.authUsername)
    .map(trunk => `inbound trunk ${trunk.sipTrunkId} ("${trunk.name}") accepts calls from any address`)
  const anyTrunkRules = rules
    .filter(rule => !rule.trunkIds.length)
    .map(rule => `dispatch rule ${rule.sipDispatchRuleId} ("${rule.name}") is bound to no trunk, so it also takes calls from addresses no trunk allows`)
  return [...openTrunks, ...anyTrunkRules]
}
