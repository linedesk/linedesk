// Call test: our test-caller agent calls the business and the result is checked in the inbox.
//   pnpm --filter @callfront/agent call-test <scenario> [--phone] [--expect-recording]
//   in the agent container: node src/call-test.ts <scenario> [--phone]
// Default (no phone): the test caller and the business's assistant talk inside one LiveKit room,
// speech and LLM only, filed in the inbox as a test call. --phone: a real call over Telnyx from
// CALL_TEST_FROM to CALL_TEST_TO (run setup-test-caller once; costs a few cents).
// Needs: the agent worker running, CALL_TEST_TO (the business number; it names the workspace),
// LiveKit env, AGENT_API_TOKEN and CALLFRONT_API_URL.
import { callFindForTest, type CallTestFinding } from '@callfront/actions'
import { AgentDispatchClient, RoomServiceClient } from 'livekit-server-sdk'
import { apiClientFromEnv, type ApiClient } from './api-client.ts'
import { AGENT_NAME, livekitHttpUrl, requireEnv, requireLivekitEnv, runScript } from './env.ts'
import { CALLEE_IDENTITY } from './test-caller/caller.ts'
import { LATENCY_ATTRIBUTE, type LatencySample } from './test-caller/latency.ts'
import { evaluateCall, formatReport } from './test-caller/report.ts'
import { isScenario, scenarioNames, scenarios, type CallTestMode, type Scenario, type ScenarioName, type TestCallerMetadata } from './test-caller/scenarios.ts'
import { findOutboundTrunk, sipClient } from './test-caller/trunk.ts'

/** A hard cap on a call, on top of the caller's own two minutes. */
const MAX_CALL_SEC = 150
/** How long to wait after hang-up for the summary and finish to land. */
const RESULT_WAIT_MS = 90_000
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

type Run = { name: ScenarioName; mode: CallTestMode; to: string; room: string; since: string; api: ApiClient }

async function waitForFinishedCall(find: () => Promise<CallTestFinding>, deadline: number, poll: () => Promise<void>): Promise<CallTestFinding> {
  let finding = await find()
  while (Date.now() < deadline && finding.call?.status !== 'completed') {
    await sleep(3000)
    await poll()
    finding = await find()
  }
  return finding
}

/** Reads the test caller's latency attribute while its room exists; keeps the last value seen. */
function latencyReader(room: string) {
  const livekit = requireLivekitEnv()
  const rooms = new RoomServiceClient(livekitHttpUrl(livekit.LIVEKIT_URL), livekit.LIVEKIT_API_KEY, livekit.LIVEKIT_API_SECRET)
  let last: LatencySample | null = null
  return {
    get: () => last,
    async poll() {
      const participants = await rooms.listParticipants(room).catch(() => [])
      for (const p of participants) {
        const value = p.attributes[LATENCY_ATTRIBUTE]
        if (value) last = JSON.parse(value) as LatencySample
      }
    },
  }
}

function dispatcher() {
  const livekit = requireLivekitEnv()
  return new AgentDispatchClient(livekitHttpUrl(livekit.LIVEKIT_URL), livekit.LIVEKIT_API_KEY, livekit.LIVEKIT_API_SECRET)
}

/** Both agents in one room: the business's as a test call of its workspace, and the test caller. */
async function startInRoom({ name, room, to, since, api }: Run) {
  const { workspaceId } = (await api.run(callFindForTest, { to, since, room })).data as CallTestFinding
  const dispatch = dispatcher()
  const caller: TestCallerMetadata = { source: 'test-caller', scenario: name, mode: 'room' }
  const { businessHours } = scenarios[name] as Scenario
  await dispatch.createDispatch(room, AGENT_NAME, { metadata: JSON.stringify({ source: 'test', workspaceId, ...(businessHours ? { businessHours } : {}) }) })
  await dispatch.createDispatch(room, AGENT_NAME, { metadata: JSON.stringify(caller) })
  console.log(`Test call in room ${room} with workspace ${workspaceId} (scenario ${name}, no phone)…`)
}

/** The test caller in its own room, dialling the business number over Telnyx. */
async function startByPhone({ name, room, to }: Run, from: string) {
  const sip = sipClient()
  const trunkId = await findOutboundTrunk(sip)
  if (!trunkId) throw new Error('No outbound trunk "callfront-test-caller": run setup-test-caller first.')
  const caller: TestCallerMetadata = { source: 'test-caller', scenario: name, mode: 'phone' }
  await dispatcher().createDispatch(room, AGENT_NAME, { metadata: JSON.stringify(caller) })
  console.log(`Calling ${to} from ${from} (scenario ${name}, room ${room})…`)
  await sip.createSipParticipant(trunkId, to, room, {
    participantIdentity: CALLEE_IDENTITY, fromNumber: from, waitUntilAnswered: true, ringingTimeout: 30, maxCallDuration: MAX_CALL_SEC,
  })
  console.log('Answered.')
}

async function main() {
  const args = process.argv.slice(2)
  const name = args.find(a => !a.startsWith('--')) ?? ''
  if (!isScenario(name)) throw new Error(`usage: call-test <scenario> [--phone] [--expect-recording]; scenarios: ${scenarioNames.join(', ')}`)
  const mode: CallTestMode = args.includes('--phone') ? 'phone' : 'room'
  const { CALL_TEST_TO: to } = requireEnv(['CALL_TEST_TO'])
  const from = mode === 'phone' ? requireEnv(['CALL_TEST_FROM']).CALL_TEST_FROM : undefined
  const run: Run = { name, mode, to, room: `call-test-${crypto.randomUUID().slice(0, 8)}`, since: new Date().toISOString(), api: apiClientFromEnv() }

  if (from) await startByPhone(run, from)
  else await startInRoom(run)
  console.log('The conversation runs for up to two minutes; waiting for the call to finish…')

  const lookup = from ? { from } : { room: run.room }
  const find = async () => (await run.api.run(callFindForTest, { to, since: run.since, ...lookup })).data as CallTestFinding
  const latency = latencyReader(run.room)
  const finding = await waitForFinishedCall(find, Date.now() + MAX_CALL_SEC * 1000 + RESULT_WAIT_MS, latency.poll)
  const checks = evaluateCall(finding, scenarios[name], { expectRecording: args.includes('--expect-recording') })
  console.log(formatReport(finding, checks, latency.get()))
  if (!checks.every(c => c.ok)) process.exitCode = 1
}

runScript(main)
