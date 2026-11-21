// LiveKit SIP trunks, by name. Inbound: "linedesk-inbound", the one trunk carriers deliver calls to,
// limited to the carriers' signaling addresses. Outbound: one for the phone call test
// ("linedesk-test-caller") and one for warm transfers ("linedesk-outbound"), each through the carrier's
// credentials (OutboundSip).
import { ListUpdate, type SIPDispatchRuleInfo, SIPHeaderOptions, SIPInboundTrunkInfo, SIPTransport } from '@livekit/protocol'
import { CALL_MAX_MINUTES } from '@linedesk/actions'
import { sipTlsFromEnv, srtpRequiredFromEnv, TRANSFER_OUTBOUND_NAME, type OutboundSip } from '@linedesk/telephony'
import { SipClient } from 'livekit-server-sdk'
import { livekitHttpUrl, requireLivekitEnv } from './env.ts'

/** The inbound trunk's audio encryption: off (plain RTP), on (SRTP when the carrier offers it), require (SRTP only). */
export type SrtpPolicy = 'off' | 'on' | 'require'
const SRTP_SETTING = { off: 'SIP_MEDIA_ENCRYPT_DISABLE', on: 'SIP_MEDIA_ENCRYPT_ALLOW', require: 'SIP_MEDIA_ENCRYPT_REQUIRE' } as const

/** What LIVEKIT_SIP_TLS asks of the inbound trunk (packages/telephony sipTlsFromEnv). */
export const srtpPolicyFromEnv = (env: Record<string, string | undefined> = process.env): SrtpPolicy =>
  srtpRequiredFromEnv(env) ? 'require' : sipTlsFromEnv(env) ? 'on' : 'off'

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

type InboundSip = Pick<SipClient, 'listSipInboundTrunk' | 'createSipInboundTrunk' | 'updateSipInboundTrunkFields' | 'updateSipInboundTrunk' | 'deleteSipTrunk'>

/**
 * The longest a call through the inbound trunk lasts: LiveKit hangs up then, whatever the agent does. A call put
 * through to a person may run this long; the assistant itself hangs up after its own limit (at most ASSISTANT_CALL_MAX_MINUTES).
 */
export const MAX_CALL_MINUTES = CALL_MAX_MINUTES

/**
 * Makes the inbound trunk of that name accept exactly these numbers from exactly these source addresses
 * (empty: any address). Updates the trunk in place, so its id and the dispatch rule pointing at it stay and
 * no call is refused while it runs; creates it if missing and deletes extra trunks of the same name.
 * Returns the trunk's id.
 */
export async function ensureInboundTrunk(
  sip: InboundSip, numbers: string[], allowedAddresses: string[], name = INBOUND_TRUNK_NAME,
  { maxCallMinutes, encryption = 'off' }: { maxCallMinutes?: number; encryption?: SrtpPolicy } = {},
): Promise<string> {
  const [existing, ...duplicates] = (await sip.listSipInboundTrunk()).filter(trunk => trunk.name === name)
  for (const duplicate of duplicates) await sip.deleteSipTrunk(duplicate.sipTrunkId)
  let trunkId: string
  if (existing) {
    await sip.updateSipInboundTrunkFields(existing.sipTrunkId, {
      numbers: new ListUpdate({ set: numbers }),
      // An empty `set` would leave the list as it is; clearing it is how "any address" is written.
      allowedAddresses: new ListUpdate(allowedAddresses.length ? { set: allowedAddresses } : { clear: true }),
    })
    trunkId = existing.sipTrunkId
  } else trunkId = (await sip.createSipInboundTrunk(name, numbers, { allowedAddresses })).sipTrunkId
  await writeTrunkSettings(sip, trunkId, numbers, allowedAddresses, maxCallMinutes, encryption)
  return trunkId
}

/**
 * Sets what only a whole new trunk (a replace) takes: every SIP header of the INVITE copied into the caller's
 * attributes (`sip.h.*`: the carrier's caller-ID attestation and spam flag, caller-attestation.ts), and the maximum
 * call length when given, and the audio encryption (LIVEKIT_SIP_TLS): SRTP allowed (`on`), required (`require`) or off.
 * The trunk as it is now is written back with them, carrying exactly the numbers and
 * addresses just set: a replace with fewer numbers would take the missing ones offline, so it is refused before
 * anything is sent.
 */
async function writeTrunkSettings(sip: InboundSip, trunkId: string, numbers: string[], allowedAddresses: string[], minutes?: number, encryption: SrtpPolicy = 'off') {
  const current = (await sip.listSipInboundTrunk()).find(trunk => trunk.sipTrunkId === trunkId)
  if (!current) throw new Error(`inbound trunk ${trunkId} is gone: its settings were not written`)
  const replacement = SIPInboundTrunkInfo.fromJson({
    ...(current.toJson() as Record<string, unknown>),
    numbers, allowedAddresses,
    includeHeaders: SIPHeaderOptions[SIPHeaderOptions.SIP_ALL_HEADERS],
    ...(minutes ? { maxCallDuration: `${minutes * 60}s` } : {}),
    media: { ...((current.toJson() as { media?: object }).media ?? {}), encryption: SRTP_SETTING[encryption] },
  })
  const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && [...a].sort().every((v, i) => v === [...b].sort()[i])
  if (!same(replacement.numbers, numbers) || !same(replacement.allowedAddresses, allowedAddresses)) {
    throw new Error(`inbound trunk ${trunkId}: the replacement would not carry every number and address; nothing changed`)
  }
  await sip.updateSipInboundTrunk(trunkId, replacement)
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
