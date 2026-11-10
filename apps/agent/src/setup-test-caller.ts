// One-time setup for the phone-to-phone call test (re-run it to repair or rotate the password):
// a Telnyx credential connection for outbound calls with the test caller's number, and the LiveKit
// SIP outbound trunk that uses it. Only objects named "callfront-test-caller" are created or changed.
// Usage: pnpm --filter @callfront/agent setup-test-caller   (needs TELNYX_API_KEY, CALL_TEST_FROM, LiveKit env)
import { createTelnyxOutbound } from '@callfront/telephony'
import { requireEnv, runScript } from './env.ts'
import { replaceOutboundTrunk, sipClient } from './test-caller/trunk.ts'

async function main() {
  const env = requireEnv(['TELNYX_API_KEY', 'CALL_TEST_FROM'])
  const outbound = await createTelnyxOutbound({ apiKey: env.TELNYX_API_KEY }).ensureOutboundSip(env.CALL_TEST_FROM)
  const trunkId = await replaceOutboundTrunk(sipClient(), env.CALL_TEST_FROM, outbound)
  console.log(`Telnyx: credential connection "callfront-test-caller" with ${env.CALL_TEST_FROM} as caller ID (SIP user ${outbound.username}, new password set)`)
  console.log(`LiveKit: outbound trunk ${trunkId} through ${outbound.address}`)
}

runScript(main)
