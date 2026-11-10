// Phone-to-phone call test: the test caller (this agent, in caller mode) calls the business number
// over the phone network, the business's assistant answers, and the call is then checked in the inbox.
// Usage: pnpm --filter @callfront/agent call-test <scenario> [--expect-recording]
// Needs: the agent worker running, `setup-test-caller` done once, CALL_TEST_FROM (caller ID) and
// CALL_TEST_TO (the business number), LiveKit env, AGENT_API_TOKEN and CALLFRONT_API_URL.
import { callFindForTest, type CallTestFinding } from '@callfront/actions'
import { AgentDispatchClient } from 'livekit-server-sdk'
import { apiClientFromEnv } from './api-client.ts'
import { AGENT_NAME, livekitHttpUrl, requireEnv, requireLivekitEnv, runScript } from './env.ts'
import { CALLEE_IDENTITY } from './test-caller/caller.ts'
import { evaluateCall, formatReport } from './test-caller/report.ts'
import { isScenario, scenarioNames, scenarios, type TestCallerMetadata } from './test-caller/scenarios.ts'
import { findOutboundTrunk, sipClient } from './test-caller/trunk.ts'

/** A hard cap on the outbound leg, on top of the caller's own two minutes. */
const MAX_CALL_SEC = 150
/** How long to wait after hang-up for the summary and finish to land. */
const RESULT_WAIT_MS = 90_000
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

async function waitForFinishedCall(find: () => Promise<CallTestFinding>, deadline: number): Promise<CallTestFinding> {
  let finding = await find()
  while (Date.now() < deadline && finding.call?.status !== 'completed') {
    await sleep(5000)
    finding = await find()
  }
  return finding
}

async function main() {
  const args = process.argv.slice(2)
  const name = args.find(a => !a.startsWith('--')) ?? ''
  if (!isScenario(name)) throw new Error(`usage: call-test <scenario> [--expect-recording]; scenarios: ${scenarioNames.join(', ')}`)
  const env = requireEnv(['CALL_TEST_FROM', 'CALL_TEST_TO'])
  const livekit = requireLivekitEnv()
  const api = apiClientFromEnv()
  const sip = sipClient()
  const trunkId = await findOutboundTrunk(sip)
  if (!trunkId) throw new Error('No outbound trunk "callfront-test-caller": run `pnpm --filter @callfront/agent setup-test-caller` first.')

  const room = `call-test-${crypto.randomUUID().slice(0, 8)}`
  const metadata: TestCallerMetadata = { source: 'test-caller', scenario: name }
  const since = new Date().toISOString()
  await new AgentDispatchClient(livekitHttpUrl(livekit.LIVEKIT_URL), livekit.LIVEKIT_API_KEY, livekit.LIVEKIT_API_SECRET)
    .createDispatch(room, AGENT_NAME, { metadata: JSON.stringify(metadata) })
  console.log(`Calling ${env.CALL_TEST_TO} from ${env.CALL_TEST_FROM} (scenario ${name}, room ${room})…`)
  await sip.createSipParticipant(trunkId, env.CALL_TEST_TO, room, {
    participantIdentity: CALLEE_IDENTITY, fromNumber: env.CALL_TEST_FROM, waitUntilAnswered: true, ringingTimeout: 30, maxCallDuration: MAX_CALL_SEC,
  })
  console.log('Answered. The conversation runs for up to two minutes; waiting for the call to finish…')

  const find = async () => (await api.run(callFindForTest, { from: env.CALL_TEST_FROM, to: env.CALL_TEST_TO, since })).data as CallTestFinding
  const finding = await waitForFinishedCall(find, Date.now() + MAX_CALL_SEC * 1000 + RESULT_WAIT_MS)
  const checks = evaluateCall(finding, scenarios[name], { expectRecording: args.includes('--expect-recording') })
  console.log(formatReport(checks))
  if (!checks.every(c => c.ok)) process.exitCode = 1
}

runScript(main)
