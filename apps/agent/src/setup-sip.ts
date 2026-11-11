// Creates the LiveKit SIP inbound trunk and the dispatch rule: every inbound call gets its own
// room and the Linedesk agent is dispatched into it. Safe to run again; it replaces both.
// With --outbound also the outbound trunk warm transfers dial through ("linedesk-outbound"): the
// carrier side is set up at TELEPHONY_PROVIDER (Telnyx for now) with a new password, and the numbers
// are the caller IDs a transfer may show (each business's own Linedesk number).
// Usage: pnpm --filter @linedesk/agent setup-sip [--outbound] [+15035550142 ...]
import { transferOutboundSipFromEnv } from '@linedesk/telephony'
import { RoomAgentDispatch, RoomConfiguration, SipClient } from 'livekit-server-sdk'
import { AGENT_NAME, livekitHttpUrl, requireLivekitEnv, runScript } from './env.ts'
import { replaceOutboundTrunk, TRANSFER_TRUNK_NAME } from './sip-trunks.ts'

const NAME = 'linedesk-inbound'
const DEMO_NUMBER = '+15035550142'

async function main() {
  const env = requireLivekitEnv()
  const args = process.argv.slice(2)
  const outbound = args.includes('--outbound')
  const numbers = args.filter(a => !a.startsWith('--'))
  if (!numbers.length) numbers.push(DEMO_NUMBER)
  const sip = new SipClient(livekitHttpUrl(env.LIVEKIT_URL), env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET)

  for (const rule of await sip.listSipDispatchRule())
    if (rule.name === NAME) await sip.deleteSipDispatchRule(rule.sipDispatchRuleId)
  for (const trunk of await sip.listSipInboundTrunk())
    if (trunk.name === NAME) await sip.deleteSipTrunk(trunk.sipTrunkId)

  const trunk = await sip.createSipInboundTrunk(NAME, numbers)
  const rule = await sip.createSipDispatchRule(
    { type: 'individual', roomPrefix: 'call-' },
    {
      name: NAME,
      trunkIds: [trunk.sipTrunkId],
      roomConfig: new RoomConfiguration({ agents: [new RoomAgentDispatch({ agentName: AGENT_NAME })] }),
    },
  )
  console.log(`inbound trunk ${trunk.sipTrunkId} accepts ${numbers.join(', ')}`)
  console.log(`dispatch rule ${rule.sipDispatchRuleId}: one room per call (call-*), agent "${AGENT_NAME}"`)

  if (outbound) {
    const credentials = await transferOutboundSipFromEnv(process.env)
    const outboundId = await replaceOutboundTrunk(sip, numbers, credentials, TRANSFER_TRUNK_NAME)
    console.log(
      `outbound trunk ${outboundId} ("${TRANSFER_TRUNK_NAME}") for warm transfers through ${credentials.address}, caller IDs ${numbers.join(', ')}`,
    )
  }
}

runScript(main)
