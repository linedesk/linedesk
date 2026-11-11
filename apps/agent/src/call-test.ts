// Call test: our test-caller agent calls the business and the result is checked in the inbox.
//   pnpm --filter @linedesk/agent call-test <scenario> [--phone] [--expect-recording] [--cancel-booking]
//   in the agent container: node src/call-test.ts <scenario> [--phone]
// Booking scenarios (booking, which-calendar) expect a real booking when the assistant has an appointment
// type and a calendar: the event stays in the calendar to look at; --cancel-booking deletes it afterwards.
// Default (no phone): the test caller and the business's assistant talk inside one LiveKit room,
// speech and LLM only, filed in the inbox as a test call. --phone: a real call over Telnyx from
// CALL_TEST_FROM to CALL_TEST_TO (run setup-test-caller once; costs a few cents).
// Needs: the agent worker running, CALL_TEST_TO (the business number; it names the workspace),
// LiveKit env, AGENT_API_TOKEN and LINEDESK_API_URL.
import { appointmentCancel, callFindForTest, type CallTestFinding } from '@linedesk/actions'
import { AgentDispatchClient, RoomServiceClient } from 'livekit-server-sdk'
import { apiClientFromEnv, type ApiClient } from './api-client.ts'
import { AGENT_NAME, livekitHttpUrl, requireEnv, requireLivekitEnv, runScript } from './env.ts'
import { CALLEE_IDENTITY } from './test-caller/caller.ts'
import { type AgentSetup, LATENCY_ATTRIBUTE, type LatencySample, SETUP_ATTRIBUTE } from './test-caller/latency.ts'
import { evaluateCall, formatReport, greetingCheck } from './test-caller/report.ts'
import { waitForFinishedCall } from './test-caller/wait.ts'
import { isScenario, phoneRefused, scenarioNames, scenarios, type CallTestMode, type Scenario, type ScenarioName, type TestCallerMetadata } from './test-caller/scenarios.ts'
import { findOutboundTrunk, sipClient } from './sip-trunks.ts'

/** A hard cap on a call, on top of the caller's own two minutes. */
const MAX_CALL_SEC = 150
/** How long to wait after hang-up for the summary and finish to land. */
const RESULT_WAIT_MS = 90_000

type Run = { name: ScenarioName; mode: CallTestMode; to: string; room: string; since: string; api: ApiClient }


/**
 * Reads, while the room exists, the test caller's latency attribute and the business agent's setup
 * attribute; keeps the last value seen of each.
 */
function latencyReader(room: string) {
  const livekit = requireLivekitEnv()
  const rooms = new RoomServiceClient(livekitHttpUrl(livekit.LIVEKIT_URL), livekit.LIVEKIT_API_KEY, livekit.LIVEKIT_API_SECRET)
  let last: LatencySample | null = null
  let setup: AgentSetup | null = null
  return {
    get: () => last,
    setup: () => setup,
    async poll() {
      const participants = await rooms.listParticipants(room).catch(() => [])
      for (const p of participants) {
        const value = p.attributes[LATENCY_ATTRIBUTE]
        if (value) last = JSON.parse(value) as LatencySample
        const own = p.attributes[SETUP_ATTRIBUTE]
        if (own) setup = JSON.parse(own) as AgentSetup
      }
    },
  }
}

function dispatcher() {
  const livekit = requireLivekitEnv()
  return new AgentDispatchClient(livekitHttpUrl(livekit.LIVEKIT_URL), livekit.LIVEKIT_API_KEY, livekit.LIVEKIT_API_SECRET)
}

/** Resolves once someone is in `room`; throws after `timeoutMs`. */
async function waitForParticipant(room: string, timeoutMs = 20_000) {
  const livekit = requireLivekitEnv()
  const rooms = new RoomServiceClient(livekitHttpUrl(livekit.LIVEKIT_URL), livekit.LIVEKIT_API_KEY, livekit.LIVEKIT_API_SECRET)
  for (const deadline = Date.now() + timeoutMs; Date.now() < deadline; await new Promise(resolve => setTimeout(resolve, 100))) {
    if ((await rooms.listParticipants(room).catch(() => [])).length) return
  }
  throw new Error(`the test caller did not join room ${room} within ${timeoutMs / 1000} s`)
}

/** Both agents in one room: the test caller, and the business's as a test call of its workspace. */
async function startInRoom({ name, room, to, since, api }: Run) {
  const { workspaceId } = (await api.run(callFindForTest, { to, since, room })).data as CallTestFinding
  const dispatch = dispatcher()
  const caller: TestCallerMetadata = { source: 'test-caller', scenario: name, mode: 'room' }
  const { businessHours, outsideGreeting, onCall } = scenarios[name] as Scenario
  const metadata = { source: 'test', workspaceId, ...(businessHours ? { businessHours } : {}), ...(outsideGreeting ? { outsideGreeting } : {}), ...(onCall ? { onCall } : {}) }
  // The caller first, as on a phone call: the caller is in the room when the business's job starts,
  // so the business's own timing from its job start is not the time the test caller takes to join.
  await dispatch.createDispatch(room, AGENT_NAME, { metadata: JSON.stringify(caller) })
  await waitForParticipant(room)
  await dispatch.createDispatch(room, AGENT_NAME, { metadata: JSON.stringify(metadata) })
  console.log(`Test call in room ${room} with workspace ${workspaceId} (scenario ${name}, no phone)…`)
}

/** The test caller in its own room, dialling the business number over Telnyx. */
async function startByPhone({ name, room, to }: Run, from: string) {
  const sip = sipClient()
  const trunkId = await findOutboundTrunk(sip)
  if (!trunkId) throw new Error('No outbound trunk "linedesk-test-caller": run setup-test-caller first.')
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
  if (!isScenario(name)) throw new Error(`usage: call-test <scenario> [--phone] [--expect-recording] [--cancel-booking]; scenarios: ${scenarioNames.join(', ')}`)
  const mode: CallTestMode = args.includes('--phone') ? 'phone' : 'room'
  // A transfer scenario over the phone would page a real on-call phone: only with the simulated person,
  // or in the live transfer test (CALL_TEST_ONCALL), where the agent dials nothing but the test on-call number.
  if (mode === 'phone' && phoneRefused(scenarios[name])) throw new Error(`${name} runs without a phone only (a simulated on-call person answers); --phone is refused (live transfer test: set CALL_TEST_ONCALL, see docs/architecture.md)`)
  const { CALL_TEST_TO: to } = requireEnv(['CALL_TEST_TO'])
  const from = mode === 'phone' ? requireEnv(['CALL_TEST_FROM']).CALL_TEST_FROM : undefined
  const run: Run = { name, mode, to, room: `call-test-${crypto.randomUUID().slice(0, 8)}`, since: new Date().toISOString(), api: apiClientFromEnv() }

  if (from) await startByPhone(run, from)
  else await startInRoom(run)
  console.log('The conversation runs for up to two minutes; waiting for the call to finish…')

  const lookup = from ? { from } : { room: run.room }
  const find = async () => (await run.api.run(callFindForTest, { to, since: run.since, ...lookup })).data as CallTestFinding
  const latency = latencyReader(run.room)
  const expectRecording = args.includes('--expect-recording')
  const finding = await waitForFinishedCall(find, Date.now() + MAX_CALL_SEC * 1000 + RESULT_WAIT_MS, latency.poll, { expectRecording })
  // Room mode: the business agent's job starts when the call is picked up, so its own timing is pickup to greeting.
  const checks = [...evaluateCall(finding, scenarios[name], { expectRecording }), ...(mode === 'room' ? [greetingCheck(latency.setup())] : [])]
  console.log(formatReport(finding, checks, latency.get(), latency.setup()))
  if (args.includes('--cancel-booking')) await cancelTestBookings(run.api, finding)
  if (!checks.every(c => c.ok)) process.exitCode = 1
}

/** Deletes what the test booked: the bookings of the test call and their calendar events. */
async function cancelTestBookings(api: ApiClient, { call, workspaceId, bookings = [] }: CallTestFinding) {
  for (const booking of bookings.filter(b => b.status !== 'cancelled')) {
    try {
      await api.run(appointmentCancel, { bookingId: booking.id, callId: call!.id }, { workspaceId })
      console.log(`Cancelled the test booking ${booking.id} and its calendar event.`)
    } catch (e) {
      console.error(`Could not cancel the test booking ${booking.id}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
}

runScript(main)
