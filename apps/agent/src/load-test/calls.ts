// Load test, the calls: starts <n> test calls at about the same time and prints one line per call (`LOADTEST {json}`):
// answered or not, the greeting time and the reply times the caller heard. The test callers go to the worker named by
// --caller-agent, the business side to the usual worker (no phone) or to whoever answers the number (--phone).
// Started by load-test/main.ts inside the caller's container:
//   node src/load-test/calls.ts <n> --caller-agent <name> --run <id> [--scenario <name>] [--spread <s>]
//     [--pipeline realtime|three_stage] [--phone] [--to <number>[,<number>…]]
//   node src/load-test/calls.ts --hang-up <id>     (ends every call of that run: the kill switch)
// No phone: both agents in one room (the business's worker is the install's own). --phone: a real call over the
// install's test-caller trunk from CALL_TEST_FROM to each number in turn (another install's numbers too), the caller
// on the three stages only; the calls start spread over --spread seconds.
// Needs what call-test needs: LiveKit env, AGENT_API_TOKEN, LINEDESK_API_URL, CALL_TEST_TO (or --to) and, for
// --phone, CALL_TEST_FROM.
import { fileURLToPath } from 'node:url'
import { VOICE_PIPELINES, type VoicePipeline } from '@linedesk/actions'
import { apiClientFromEnv } from '../api-client.ts'
import { requireEnv, runScript } from '../env.ts'
import { endRoom, hangUpRooms, latencyReader, startByPhone, startInRoom, waitForCallEnd } from '../test-caller/room.ts'
import {
  callTestCapSeconds,
  isScenario,
  phoneRefused,
  scenarioNames,
  scenarios,
  type ScenarioName,
} from '../test-caller/scenarios.ts'

/** A hard cap on a call without a phone, on top of the test caller's own three minutes. */
const MAX_CALL_MS = 210_000

export type CallResult = {
  index: number
  room: string
  /** The number dialled (phone) or the number naming the workspace (no phone). */
  to: string
  /** No phone: the business agent joined and said what its setup took. Phone: the business picked up. */
  answered: boolean
  /** No phone: pickup to the first audio of the greeting, as the business agent measured it. */
  greetingMs: number | null
  /** Phone: from the dial to the first business audio the caller heard. No phone: from the caller's join. */
  heardGreetingMs: number | null
  /** Phone: from the dial to the pickup. */
  pickupMs: number | null
  /** Each reply as the test caller heard it: from the end of its own line to the business's first sound. */
  replyMs: number[]
  durationMs: number
  /** The call could not be placed or was not answered (phone), or could not be started (no phone). */
  dialFailed: boolean
  /** Why the call failed or heard nothing; absent on a good call. */
  error?: string
}

export type CallsOptions = {
  calls: number
  callerAgent: string
  run: string
  scenario: ScenarioName
  spreadMs: number
  phone: boolean
  to: string[]
  pipeline?: VoicePipeline
}

const flag = (args: string[], name: string) => {
  const at = args.indexOf(name)
  return at >= 0 ? args[at + 1] : undefined
}

export function parseCallsArgs(args: string[]): CallsOptions {
  const calls = Number(args[0])
  if (!Number.isInteger(calls) || calls < 1)
    throw new Error(
      'usage: calls.ts <n> --caller-agent <name> --run <id> [--scenario …] [--spread <s>] [--phone] [--to …]',
    )
  const callerAgent = flag(args, '--caller-agent')
  if (!callerAgent) throw new Error('--caller-agent is required: the worker that plays the test callers')
  const run = flag(args, '--run')
  if (!run || !/^[\w-]+$/.test(run)) throw new Error('--run takes the id of the run (letters, digits, -)')
  const scenario = flag(args, '--scenario') ?? 'callback-message'
  if (!isScenario(scenario)) throw new Error(`--scenario takes one of ${scenarioNames.join(', ')}`)
  const spreadMs = Number(flag(args, '--spread') ?? 2) * 1000
  if (!Number.isFinite(spreadMs) || spreadMs < 0) throw new Error('--spread takes seconds')
  const pipeline = flag(args, '--pipeline')
  if (pipeline !== undefined && !(VOICE_PIPELINES as readonly string[]).includes(pipeline))
    throw new Error(`--pipeline takes ${VOICE_PIPELINES.join(' or ')}`)
  const phone = args.includes('--phone')
  if (phone && pipeline)
    throw new Error("--pipeline works without a phone only; over the phone the assistant's own setting applies")
  const to = (flag(args, '--to') ?? '').split(',').filter(Boolean)
  return {
    calls,
    callerAgent,
    run,
    scenario,
    spreadMs,
    phone,
    to,
    ...(pipeline ? { pipeline: pipeline as VoicePipeline } : {}),
  }
}

/**
 * When call `index` of `calls` starts. Phone: evenly over the window `spreadMs` (all calls of a level start within it).
 * No phone: `spreadMs` between one call and the next, as before.
 */
export const startDelayMs = (index: number, calls: number, spreadMs: number, phone: boolean) =>
  phone ? Math.round((index * spreadMs) / calls) : index * spreadMs

/** The number call `index` dials: the numbers in turn, so the calls share out over several workspaces. */
export const numberFor = (index: number, to: string[]) => to[index % to.length]!

/** Room names of a run start with this; the kill switch deletes them by it (main.ts passes `<run>-<level>` per level). */
export const roomPrefix = (run: string) => `load-test-${run}-`

const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

async function runRoomCall(index: number, room: string, options: CallsOptions, to: string): Promise<CallResult> {
  const started = Date.now()
  const latency = latencyReader(room)
  const base = { index, room, to, pickupMs: null }
  try {
    const call = {
      name: options.scenario,
      to,
      room,
      since: new Date().toISOString(),
      api: apiClientFromEnv(),
      pipeline: options.pipeline,
    }
    await startInRoom(call, options.callerAgent)
    await waitForCallEnd(room, started + MAX_CALL_MS, latency.poll)
  } catch (e) {
    return {
      ...base,
      answered: false,
      greetingMs: null,
      heardGreetingMs: null,
      replyMs: [],
      durationMs: Date.now() - started,
      dialFailed: true,
      error: message(e),
    }
  }
  const setup = latency.setup()
  return {
    ...base,
    answered: setup !== null,
    greetingMs: setup?.steps['greeting audio'] ?? null,
    heardGreetingMs: latency.get()?.greetingMs ?? null,
    replyMs: latency.get()?.replyMs ?? [],
    durationMs: Date.now() - started,
    dialFailed: false,
    ...(setup === null ? { error: 'the business agent did not join' } : {}),
  }
}

async function runPhoneCall(
  index: number,
  room: string,
  options: CallsOptions,
  to: string,
  from: string,
): Promise<CallResult> {
  const maxCallSeconds = callTestCapSeconds(scenarios[options.scenario])
  const started = Date.now()
  const latency = latencyReader(room)
  const base = { index, room, to, greetingMs: null }
  try {
    await startByPhone({ name: options.scenario, room, to }, from, maxCallSeconds, {
      callerAgent: options.callerAgent,
      threeStage: true,
    })
  } catch (e) {
    await endRoom(room)
    const failed = { ...base, heardGreetingMs: null, pickupMs: null, replyMs: [], dialFailed: true }
    return { ...failed, answered: false, durationMs: Date.now() - started, error: `dial: ${message(e)}` }
  }
  const pickupMs = Date.now() - started
  await waitForCallEnd(room, started + (maxCallSeconds + 30) * 1000, latency.poll)
  // The room outlived the cap (a leg that did not hang up): end it, so no line stays open.
  await endRoom(room)
  const heard = latency.get()
  const heardGreetingMs = heard?.greetingMs == null ? null : pickupMs + heard.greetingMs
  return {
    ...base,
    answered: true,
    heardGreetingMs,
    pickupMs,
    replyMs: heard?.replyMs ?? [],
    durationMs: Date.now() - started,
    dialFailed: false,
    ...(heardGreetingMs === null ? { error: 'no business audio heard' } : {}),
  }
}

async function main() {
  const args = process.argv.slice(2)
  if (args[0] === '--hang-up') {
    const run = args[1]
    if (!run || !/^\w+$/.test(run)) throw new Error('usage: calls.ts --hang-up <run id>')
    // Calls of a level still being started appear after the first pass: go on until two passes in a row find none.
    let total = 0
    for (let pass = 0, quiet = 0; pass < 15 && quiet < 2; pass++) {
      const ended = await hangUpRooms(roomPrefix(run))
      total += ended
      quiet = ended ? 0 : quiet + 1
      await new Promise(resolve => setTimeout(resolve, 2000))
    }
    console.log(`Hung up ${total} call(s) of run ${run}.`)
    return
  }
  const options = parseCallsArgs(args)
  const to = options.to.length ? options.to : [requireEnv(['CALL_TEST_TO']).CALL_TEST_TO]
  const from = options.phone ? requireEnv(['CALL_TEST_FROM']).CALL_TEST_FROM : null
  // Over the phone a transfer scenario would page a real on-call phone of the install that answers.
  if (from && phoneRefused(scenarios[options.scenario], process.env, true))
    throw new Error(
      `${options.scenario} involves a transfer to an on-call phone; refused over the phone in a load test`,
    )
  await Promise.all(
    Array.from({ length: options.calls }, async (_, index) => {
      await new Promise(resolve =>
        setTimeout(resolve, startDelayMs(index, options.calls, options.spreadMs, options.phone)),
      )
      const room = `${roomPrefix(options.run)}${index}`
      const number = numberFor(index, to)
      const result = from
        ? await runPhoneCall(index, room, options, number, from)
        : await runRoomCall(index, room, options, number)
      console.log(`LOADTEST ${JSON.stringify(result)}`)
    }),
  )
}

if (process.argv[1] === fileURLToPath(import.meta.url)) runScript(main)
