// Call test: our test-caller agent calls the business and the result is checked in the inbox.
//   pnpm --filter @linedesk/agent call-test <scenario> [--phone [--external]] [--pipeline realtime|three_stage] [--expect-recording] [--cancel-booking] [--persona "<who the caller is>"]
// --persona: the caller plays this instead of the scenario's persona; the scenario's checks stay.
// --pipeline (no phone only): the business answers this call with it instead of its assistant's choice; over the
// phone the assistant's own setting applies (Settings › Assistant, "Answered by").
// --realtime-model <id> (no phone only): a realtime call uses this OpenAI model (gpt-realtime, gpt-realtime-mini, …)
// instead of the install's, to compare models without changing Server admin › Providers.
//   in the agent container: node src/call-test.ts <scenario> [--phone]
// Booking scenarios (booking, which-calendar) expect a real booking when the assistant has an appointment
// type and a calendar: the event stays in the calendar to look at; --cancel-booking deletes it afterwards.
// Default (no phone): the test caller and the business's assistant talk inside one LiveKit room,
// speech and LLM only, filed in the inbox as a test call. --phone: a real call over Telnyx from
// CALL_TEST_FROM to CALL_TEST_TO (run setup-test-caller once; costs a few cents).
// Needs: the agent worker running, CALL_TEST_TO (the business number; it names the workspace),
// LiveKit env, AGENT_API_TOKEN and LINEDESK_API_URL.
import {
  appointmentCancel,
  callFindForTest,
  callRecordTimings,
  type CallTestFinding,
  VOICE_PIPELINES,
  type VoicePipeline,
} from '@linedesk/actions'
import { apiClientFromEnv, type ApiClient } from './api-client.ts'
import { isRealtimeModelId } from './call-session.ts'
import { requireEnv, runScript } from './env.ts'
import { evaluateCall, formatCallerLatency, formatReport, greetingCheck } from './test-caller/report.ts'
import { latencyReader, type RoomCall, startByPhone, startInRoom, waitForCallEnd } from './test-caller/room.ts'
import { waitForFinishedCall } from './test-caller/wait.ts'
import {
  callTestCapSeconds,
  isScenario,
  parseCallTestArgs,
  roomRefused,
  phoneRefused,
  scenarioNames,
  scenarios,
  type CallTestMode,
} from './test-caller/scenarios.ts'

/** How long to wait after hang-up for the summary and finish to land. */
const RESULT_WAIT_MS = 90_000

type Run = RoomCall & { mode: CallTestMode }

const isPipeline = (value: string | undefined): value is VoicePipeline =>
  (VOICE_PIPELINES as readonly (string | undefined)[]).includes(value)

async function main() {
  const args = process.argv.slice(2)
  const { name, persona, pipeline, realtimeModel } = parseCallTestArgs(args)
  if (!isScenario(name))
    throw new Error(
      `usage: call-test <scenario> [--phone [--external]] [--pipeline realtime|three_stage] [--expect-recording] [--cancel-booking] [--persona "…"]; scenarios: ${scenarioNames.join(', ')}`,
    )
  const mode: CallTestMode = args.includes('--phone') ? 'phone' : 'room'
  if (args.includes('--pipeline') && !isPipeline(pipeline))
    throw new Error(`--pipeline takes ${VOICE_PIPELINES.join(' or ')}`)
  if (args.includes('--realtime-model') && !isRealtimeModelId(realtimeModel))
    throw new Error('--realtime-model takes an OpenAI realtime model id, e.g. gpt-realtime or gpt-realtime-mini')
  if (realtimeModel && mode === 'phone')
    throw new Error('--realtime-model works without a phone only; over the phone the install\'s model applies (Server admin › Providers)')
  if (pipeline && mode === 'phone')
    throw new Error(
      '--pipeline works without a phone only; over the phone the assistant\'s own setting applies (Settings › Assistant, "Answered by")',
    )
  // A transfer scenario over the phone would page a real on-call phone: only with the simulated person,
  // or in the live transfer test (CALL_TEST_ONCALL), where the agent dials nothing but the test on-call number.
  const external = args.includes('--external')
  if (mode === 'phone' && phoneRefused(scenarios[name], process.env, external))
    throw new Error(
      external
        ? `${name} involves a transfer to an on-call phone; with --external the other install answers and would page its real on-call phone, so it is refused. Run it on that install, or without --phone.`
        : `${name} runs without a phone only (a simulated on-call person answers); --phone is refused (live transfer test: set CALL_TEST_ONCALL, see docs/architecture.md)`,
    )
  if (mode === 'room' && roomRefused(scenarios[name]))
    throw new Error(`${name} is a long call: run it with --phone (a test call in a room ends after a few minutes), with the assistant's call length set to cover it`)
  const maxCallSeconds = callTestCapSeconds(scenarios[name])
  const { CALL_TEST_TO: to } = requireEnv(['CALL_TEST_TO'])
  const from = mode === 'phone' ? requireEnv(['CALL_TEST_FROM']).CALL_TEST_FROM : undefined
  const run: Run = {
    name,
    mode,
    to,
    room: `call-test-${crypto.randomUUID().slice(0, 8)}`,
    since: new Date().toISOString(),
    api: apiClientFromEnv(),
    persona,
    pipeline: isPipeline(pipeline) ? pipeline : undefined,
    realtimeModel,
  }

  if (from) {
    console.log(`Calling ${to} from ${from} (scenario ${name}, room ${run.room})…`)
    await startByPhone(run, from, maxCallSeconds)
    console.log('Answered.')
  }
  else await startInRoom(run)
  console.log(`The conversation runs for up to ${Math.round(maxCallSeconds / 60)} minutes; waiting for the call to finish…`)

  const latency = latencyReader(run.room)
  // A number of another install (--external, phone only): this install has no record of the call, so there is nothing to
  // check; what the caller heard is all there is. The call's own data is on the install that answered.
  if (from && external) {
    await waitForCallEnd(run.room, Date.now() + maxCallSeconds * 1000, latency.poll)
    console.log(formatCallerLatency(latency.get()))
    console.log(
      'External number: no checks here; the call, its transcript and reply times are on the install that answered.',
    )
    return
  }
  const lookup = from ? { from } : { room: run.room }
  const find = async () =>
    (await run.api.run(callFindForTest, { to, since: run.since, ...lookup })).data as CallTestFinding
  const expectRecording = args.includes('--expect-recording')
  const finding = await waitForFinishedCall(find, Date.now() + maxCallSeconds * 1000 + RESULT_WAIT_MS, latency.poll, {
    expectRecording,
  })
  // Room mode: the business agent's job starts when the call is picked up, so its own timing is pickup to greeting.
  const checks = [
    ...evaluateCall(finding, scenarios[name], { expectRecording }),
    ...(mode === 'room' ? [greetingCheck(latency.setup())] : []),
  ]
  console.log(formatReport(finding, checks, latency.get(), latency.setup()))
  if (mode === 'phone') await recordHeard(run.api, finding, latency.get()?.replyMs ?? [])
  if (args.includes('--cancel-booking')) await cancelTestBookings(run.api, finding)
  if (!checks.every(c => c.ok)) process.exitCode = 1
}

/**
 * What the caller heard over the phone, per reply, onto the call (admin overview, Reply delay): set against the agent's
 * own times of the same call, it gives the phone network's share. A failure is only reported.
 */
async function recordHeard(api: ApiClient, { call, workspaceId }: CallTestFinding, heardMs: number[]) {
  if (!call || !heardMs.length) return
  const at = new Date().toISOString()
  try {
    await api.run(
      callRecordTimings,
      { callId: call.id, pipeline: 'phone', replies: heardMs.map(ms => ({ at, heardMs: Math.round(ms) })) },
      { workspaceId },
    )
  } catch (e) {
    console.error(`Could not store what the caller heard: ${e instanceof Error ? e.message : String(e)}`)
  }
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
