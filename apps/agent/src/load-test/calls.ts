// Load test, the calls: starts <n> test calls without a phone at about the same time and prints one line per call
// (`LOADTEST {json}`): answered or not, the business's greeting time from pickup and the reply times the caller heard.
// The test callers go to the worker named by --caller-agent, the business side to the usual worker, so the
// business worker's memory and CPU are those of <n> calls. Started by load-test/main.ts inside the caller's container:
//   node src/load-test/calls.ts <n> --caller-agent <name> [--scenario <name>] [--spread <s>] [--pipeline realtime|three_stage]
// Needs what call-test needs: LiveKit env, AGENT_API_TOKEN, LINEDESK_API_URL and CALL_TEST_TO.
import { fileURLToPath } from 'node:url'
import { VOICE_PIPELINES, type VoicePipeline } from '@linedesk/actions'
import { apiClientFromEnv } from '../api-client.ts'
import { requireEnv, runScript } from '../env.ts'
import { latencyReader, startInRoom, waitForCallEnd } from '../test-caller/room.ts'
import { isScenario, scenarioNames, type ScenarioName } from '../test-caller/scenarios.ts'

/** A hard cap on a call, on top of the test caller's own three minutes. */
const MAX_CALL_MS = 210_000

export type CallResult = {
  index: number
  room: string
  /** The business agent joined and said what its setup took (the setup attribute). */
  answered: boolean
  /** Pickup to the first audio of the greeting, as the business agent measured it. */
  greetingMs: number | null
  /** Each reply as the test caller heard it: from the end of its own line to the business's first sound. */
  replyMs: number[]
  durationMs: number
  error?: string
}

type Options = {
  calls: number
  callerAgent: string
  scenario: ScenarioName
  spreadMs: number
  pipeline?: VoicePipeline
}

const flag = (args: string[], name: string) => {
  const at = args.indexOf(name)
  return at >= 0 ? args[at + 1] : undefined
}

export function parseCallsArgs(args: string[]): Options {
  const calls = Number(args[0])
  if (!Number.isInteger(calls) || calls < 1)
    throw new Error('usage: calls.ts <n> --caller-agent <name> [--scenario …] [--spread <s>] [--pipeline …]')
  const callerAgent = flag(args, '--caller-agent')
  if (!callerAgent) throw new Error('--caller-agent is required: the worker that plays the test callers')
  const scenario = flag(args, '--scenario') ?? 'callback-message'
  if (!isScenario(scenario)) throw new Error(`--scenario takes one of ${scenarioNames.join(', ')}`)
  const spreadMs = Number(flag(args, '--spread') ?? 2) * 1000
  if (!Number.isFinite(spreadMs) || spreadMs < 0) throw new Error('--spread takes seconds between call starts')
  const pipeline = flag(args, '--pipeline')
  if (pipeline !== undefined && !(VOICE_PIPELINES as readonly string[]).includes(pipeline))
    throw new Error(`--pipeline takes ${VOICE_PIPELINES.join(' or ')}`)
  return { calls, callerAgent, scenario, spreadMs, ...(pipeline ? { pipeline: pipeline as VoicePipeline } : {}) }
}

async function runCall(index: number, run: string, options: Options, to: string): Promise<CallResult> {
  await new Promise(resolve => setTimeout(resolve, index * options.spreadMs))
  const room = `load-test-${run}-${index}`
  const started = Date.now()
  const latency = latencyReader(room)
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
      index,
      room,
      answered: false,
      greetingMs: null,
      replyMs: [],
      durationMs: Date.now() - started,
      error: e instanceof Error ? e.message : String(e),
    }
  }
  const setup = latency.setup()
  return {
    index,
    room,
    answered: setup !== null,
    greetingMs: setup?.steps['greeting audio'] ?? null,
    replyMs: latency.get()?.replyMs ?? [],
    durationMs: Date.now() - started,
  }
}

async function main() {
  const options = parseCallsArgs(process.argv.slice(2))
  const { CALL_TEST_TO: to } = requireEnv(['CALL_TEST_TO'])
  const run = crypto.randomUUID().slice(0, 6)
  await Promise.all(
    Array.from({ length: options.calls }, async (_, index) => {
      const result = await runCall(index, run, options, to)
      console.log(`LOADTEST ${JSON.stringify(result)}`)
    }),
  )
}

if (process.argv[1] === fileURLToPath(import.meta.url)) runScript(main)
