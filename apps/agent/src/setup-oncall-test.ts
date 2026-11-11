// Live warm-transfer test: sends calls to the test on-call number to the on-call responder
// (oncall-responder.ts) instead of the business's assistant. Its own inbound trunk
// ("linedesk-oncall-test", same carrier address list as linedesk-inbound) and dispatch rule, so
// setup-sip never needs this number. Safe to run again; --answer changes what the responder does.
// The number itself is bought and pointed at LiveKit SIP like any other (Telnyx connection linedesk-livekit).
// Usage: pnpm --filter @linedesk/agent setup-oncall-test <+1NUMBER> [--answer accept|decline|no-answer]
//   in the agent container: node src/setup-oncall-test.ts <+1NUMBER> [--answer ...]
import { RoomAgentDispatch, RoomConfiguration } from 'livekit-server-sdk'
import { AGENT_NAME, runScript } from './env.ts'
import { inboundAllowlistFromEnv } from './inbound-allowlist.ts'
import { ONCALL_RESPONDER_SOURCE, type OnCallResponderMetadata } from './oncall-responder.ts'
import { parseSetupOnCallTestArgs } from './setup-args.ts'
import { ensureInboundTrunk, INBOUND_TRUNK_NAME, sipClient } from './sip-trunks.ts'

const ONCALL_TEST_NAME = 'linedesk-oncall-test'

async function main() {
  const { number, answer } = parseSetupOnCallTestArgs(process.argv.slice(2))
  const allowlist = inboundAllowlistFromEnv()
  const sip = sipClient()
  const business = (await sip.listSipInboundTrunk()).find(trunk => trunk.name === INBOUND_TRUNK_NAME)
  if (business?.numbers.includes(number))
    throw new Error(
      `${number} is on ${INBOUND_TRUNK_NAME}: run setup-sip without it first, a number belongs to one trunk`,
    )

  const trunkId = await ensureInboundTrunk(sip, [number], allowlist.addresses, ONCALL_TEST_NAME)
  for (const rule of await sip.listSipDispatchRule())
    if (rule.name === ONCALL_TEST_NAME) await sip.deleteSipDispatchRule(rule.sipDispatchRuleId)
  const metadata: OnCallResponderMetadata = { source: ONCALL_RESPONDER_SOURCE, answer }
  const rule = await sip.createSipDispatchRule(
    { type: 'individual', roomPrefix: 'oncall-test-' },
    {
      name: ONCALL_TEST_NAME,
      trunkIds: [trunkId],
      roomConfig: new RoomConfiguration({
        agents: [new RoomAgentDispatch({ agentName: AGENT_NAME, metadata: JSON.stringify(metadata) })],
      }),
    },
  )
  console.log(`inbound trunk ${trunkId} ("${ONCALL_TEST_NAME}") accepts ${number}`)
  if (allowlist.addresses.length)
    console.log(`  only from ${allowlist.sources.join(' + ')} signaling addresses (${allowlist.addresses.length})`)
  else console.warn('  WARNING: from any address (LIVEKIT_SIP_ALLOWED_ADDRESSES=any)')
  console.log(
    `dispatch rule ${rule.sipDispatchRuleId}: one room per call (oncall-test-*), the on-call responder answers "${answer}"`,
  )
}

runScript(main)
