// Creates the LiveKit SIP inbound trunk and the dispatch rule: every inbound call gets its own
// room and the Linedesk agent is dispatched into it. Safe to run again; it replaces both.
// Usage: pnpm --filter @linedesk/agent setup-sip [+15035550142 ...]
import { RoomAgentDispatch, RoomConfiguration, SipClient } from 'livekit-server-sdk'
import { AGENT_NAME, livekitHttpUrl, requireLivekitEnv, runScript } from './env.ts'

const NAME = 'linedesk-inbound'
const DEMO_NUMBER = '+15035550142'

async function main() {
  const env = requireLivekitEnv()
  const numbers = process.argv.slice(2)
  if (!numbers.length) numbers.push(DEMO_NUMBER)
  const sip = new SipClient(livekitHttpUrl(env.LIVEKIT_URL), env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET)

  for (const rule of await sip.listSipDispatchRule()) if (rule.name === NAME) await sip.deleteSipDispatchRule(rule.sipDispatchRuleId)
  for (const trunk of await sip.listSipInboundTrunk()) if (trunk.name === NAME) await sip.deleteSipTrunk(trunk.sipTrunkId)

  const trunk = await sip.createSipInboundTrunk(NAME, numbers)
  const rule = await sip.createSipDispatchRule({ type: 'individual', roomPrefix: 'call-' }, {
    name: NAME,
    trunkIds: [trunk.sipTrunkId],
    roomConfig: new RoomConfiguration({ agents: [new RoomAgentDispatch({ agentName: AGENT_NAME })] }),
  })
  console.log(`inbound trunk ${trunk.sipTrunkId} accepts ${numbers.join(', ')}`)
  console.log(`dispatch rule ${rule.sipDispatchRuleId}: one room per call (call-*), agent "${AGENT_NAME}"`)
}

runScript(main)
