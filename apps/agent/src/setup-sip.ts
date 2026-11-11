// Creates or updates the LiveKit SIP inbound trunk and the dispatch rule: every inbound call gets its own
// room and the Linedesk agent is dispatched into it. The trunk only takes calls from the carriers' published
// signaling addresses (LIVEKIT_SIP_ALLOWED_ADDRESSES, default "telnyx twilio"; see inbound-allowlist.ts).
// Safe to run again: the trunk is updated in place, the dispatch rule replaced.
// With --outbound also the outbound trunk warm transfers dial through ("linedesk-outbound"): the
// carrier side is set up at TELEPHONY_PROVIDER (Telnyx for now) with a new password, and the numbers
// are the caller IDs a transfer may show (each business's own Linedesk number).
// --print-allowed-addresses prints the address list, one per line, and changes nothing (for a firewall).
// The numbers replace the trunk's whole list, so every number that must keep working is passed each time;
// no number or an unknown option prints the usage and changes nothing.
// Usage: pnpm --filter @linedesk/agent setup-sip [--outbound] <+15035550142 ...> | --print-allowed-addresses
import { transferOutboundSipFromEnv } from '@linedesk/telephony'
import { RoomAgentDispatch, RoomConfiguration, SipClient } from 'livekit-server-sdk'
import { AGENT_NAME, livekitHttpUrl, requireLivekitEnv, runScript } from './env.ts'
import { inboundAllowlistFromEnv } from './inbound-allowlist.ts'
import { parseSetupSipArgs } from './setup-args.ts'
import { ensureInboundTrunk, INBOUND_TRUNK_NAME, openInboundWarnings, replaceOutboundTrunk, TRANSFER_TRUNK_NAME } from './sip-trunks.ts'

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

  const trunkId = await ensureInboundTrunk(sip, numbers, allowlist.addresses)
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
  console.log(`inbound trunk ${trunkId} accepts ${numbers.join(', ')}`)
  if (allowlist.addresses.length) {
    console.log(`  only from ${allowlist.sources.join(' + ')} signaling addresses (${allowlist.addresses.length}): ${allowlist.addresses.join(' ')}`)
  } else {
    console.warn('  WARNING: from any address (LIVEKIT_SIP_ALLOWED_ADDRESSES=any): anyone who reaches port 5060 can call the assistant')
  }
  console.log(`dispatch rule ${rule.sipDispatchRuleId}: one room per call (call-*), agent "${AGENT_NAME}"`)
  for (const warning of openInboundWarnings(await sip.listSipInboundTrunk(), await sip.listSipDispatchRule())) console.warn(`WARNING: ${warning}`)

  if (outbound) {
    const credentials = await transferOutboundSipFromEnv(process.env)
    const outboundId = await replaceOutboundTrunk(sip, numbers, credentials, TRANSFER_TRUNK_NAME)
    console.log(
      `outbound trunk ${outboundId} ("${TRANSFER_TRUNK_NAME}") for warm transfers through ${credentials.address}, caller IDs ${numbers.join(', ')}`,
    )
  }
}

runScript(main)
