// Creates or updates the LiveKit SIP inbound trunk and the dispatch rule: every inbound call gets its own
// room and the Linedesk agent is dispatched into it. The trunk only takes calls from the carriers' published
// signaling addresses (LIVEKIT_SIP_ALLOWED_ADDRESSES, default "telnyx twilio"; see inbound-allowlist.ts).
// Safe to run again: the trunk is updated in place, the dispatch rule replaced. Calls through the trunk end after
// MAX_CALL_MINUTES, 2 hours (LiveKit hangs up; the assistant itself leaves after its own limit, at most 30 minutes), set by writing the trunk back whole with the same numbers and addresses.
// With --outbound also the outbound trunk warm transfers dial through ("linedesk-outbound"): the
// carrier side is set up at TELEPHONY_PROVIDER (Telnyx for now) with a new password, and the numbers
// are the caller IDs a transfer may show (each business's own Linedesk number). The Telnyx voice profile may call the
// countries of those numbers plus OUTBOUND_COUNTRIES (the API keeps it to the install's list afterwards).
// --print-allowed-addresses prints the address list, one per line, and changes nothing (for a firewall).
// The numbers replace the trunk's whole list, so every number that must keep working is passed each time (the API
// writes the connected numbers back within minutes anyway: apps/api/src/inbound-trunk.ts);
// no number or an unknown option prints the usage and changes nothing.
// Usage: pnpm --filter @linedesk/agent setup-sip [--outbound] <+15035550142 ...> | --print-allowed-addresses
import { countriesOfNumbers, parseCountryList } from '@linedesk/actions'
import { transferOutboundSipFromEnv } from '@linedesk/telephony'
import { RoomAgentDispatch, RoomConfiguration, SipClient } from 'livekit-server-sdk'
import { AGENT_NAME, livekitHttpUrl, requireLivekitEnv, runScript } from './env.ts'
import { inboundAllowlistFromEnv } from './inbound-allowlist.ts'
import { parseSetupSipArgs } from './setup-args.ts'
import { ensureInboundTrunk, INBOUND_TRUNK_NAME, MAX_CALL_MINUTES, openInboundWarnings, replaceOutboundTrunk, srtpPolicyFromEnv, TRANSFER_TRUNK_NAME } from './sip-trunks.ts'

const NAME = INBOUND_TRUNK_NAME

async function main() {
  const args = parseSetupSipArgs(process.argv.slice(2))
  const allowlist = inboundAllowlistFromEnv()
  if (args.printAllowedAddresses) {
    if (!allowlist.addresses.length) throw new Error('LIVEKIT_SIP_ALLOWED_ADDRESSES is "any": there is no address list')
    for (const address of allowlist.addresses) console.log(address)
    return
  }
  const env = requireLivekitEnv()
  const { outbound, numbers } = args
  const sip = new SipClient(livekitHttpUrl(env.LIVEKIT_URL), env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET)

  const encryption = srtpPolicyFromEnv()
  const before = (await sip.listSipInboundTrunk()).find(trunk => trunk.name === NAME)?.toJson() as { media?: { encryption?: string } } | undefined
  const trunkId = await ensureInboundTrunk(sip, numbers, allowlist.addresses, NAME, { maxCallMinutes: MAX_CALL_MINUTES, encryption })
  const was = before?.media?.encryption
  if (encryption === 'off' && was && was !== 'SIP_MEDIA_ENCRYPT_DISABLE') {
    console.warn(`  WARNING: the inbound trunk took SRTP (${was}); LIVEKIT_SIP_TLS is not set here, so it is plain RTP only now. Calls a carrier sends with SRTP are refused until setup-sip runs where LIVEKIT_SIP_TLS is on.`)
  }
  for (const rule of await sip.listSipDispatchRule())
    if (rule.name === NAME) await sip.deleteSipDispatchRule(rule.sipDispatchRuleId)
  const rule = await sip.createSipDispatchRule(
    { type: 'individual', roomPrefix: 'call-' },
    {
      name: NAME,
      trunkIds: [trunkId],
      roomConfig: new RoomConfiguration({ agents: [new RoomAgentDispatch({ agentName: AGENT_NAME })] }),
    },
  )
  console.log(`inbound trunk ${trunkId} accepts ${numbers.join(', ')}; calls end after ${MAX_CALL_MINUTES} minutes; audio: ${{ off: 'plain RTP', on: 'SRTP or plain RTP (LIVEKIT_SIP_TLS=on)', require: 'SRTP only (LIVEKIT_SIP_TLS=require)' }[encryption]}`)
  if (allowlist.addresses.length) {
    console.log(`  only from ${allowlist.sources.join(' + ')} signaling addresses (${allowlist.addresses.length}): ${allowlist.addresses.join(' ')}`)
  } else {
    console.warn('  WARNING: from any address (LIVEKIT_SIP_ALLOWED_ADDRESSES=any): anyone who reaches port 5060 can call the assistant')
  }
  console.log(`dispatch rule ${rule.sipDispatchRuleId}: one room per call (call-*), agent "${AGENT_NAME}"`)
  for (const warning of openInboundWarnings(await sip.listSipInboundTrunk(), await sip.listSipDispatchRule())) console.warn(`WARNING: ${warning}`)

  if (outbound) {
    const destinations = [
      ...new Set([...countriesOfNumbers(numbers), ...parseCountryList(process.env.OUTBOUND_COUNTRIES)]),
    ]
    const credentials = await transferOutboundSipFromEnv(
      process.env,
      undefined,
      destinations.length ? destinations : undefined,
    )
    const outboundId = await replaceOutboundTrunk(sip, numbers, credentials, TRANSFER_TRUNK_NAME)
    console.log(
      `outbound trunk ${outboundId} ("${TRANSFER_TRUNK_NAME}") for warm transfers through ${credentials.address}, caller IDs ${numbers.join(', ')}, to ${destinations.join(', ') || 'US'}`,
    )
  }
}

runScript(main)
