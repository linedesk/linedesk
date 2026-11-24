// Plays a scripted call through the real API, so the inbox shows a live call without any
// telephony or speech provider. Usage: pnpm --filter @linedesk/agent simulate [script] [--fast] [--to <number>]
// The number dialled: --to, else SIM_TO_NUMBER, else the install's only Linedesk number.
import { pathToFileURL } from 'node:url'
import { callListNumbers } from '@linedesk/actions'
import { ActionError, apiClientFromEnv, type ApiClient } from './api-client.ts'
import { startCall } from './call-session.ts'
import { runScript } from './env.ts'
import { FALLBACK_GREETING } from './prompt.ts'
import { simScripts, type SimLine, type SimScript } from './sim-scripts.ts'

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

/** Roughly how long it takes to say a line: 2 to 6 seconds. */
export const speakingDelayMs = (line: SimLine) =>
  line.speaker === 'system' ? 600 : Math.min(6000, 2000 + line.text.length * 35)

export interface PlayOptions {
  to: string
  wait?: (ms: number) => Promise<unknown>
  log?: (line: string) => void
}

export async function playScript(api: ApiClient, script: SimScript, { to, wait = sleep, log = () => {} }: PlayOptions) {
  const call = await startCall(api, { kind: 'phone', from: script.from, to, simulated: true })
  log(`call ${call.callId} started (${script.from} -> ${to})`)
  for (const line of script.lines) {
    await wait(speakingDelayMs(line))
    const text = line.text.replace('{greeting}', call.assistant?.greeting || FALLBACK_GREETING)
    await call.append(line.speaker, text, line.tool ? { tool: line.tool, label: text } : undefined)
    log(`${line.speaker.padEnd(6)} ${text}`)
  }
  await wait(1500)
  await call.finish(script.result)
  log(`call ${call.callId} finished: ${script.result.outcome}`)
  return call.callId
}

/** `--to <number>` or `--to=<number>`; the rest are the script name and flags. */
export function parseArgs(args: string[]) {
  const at = args.findIndex(a => a === '--to' || a.startsWith('--to='))
  const to = at < 0 ? undefined : args[at]!.startsWith('--to=') ? args[at]!.slice(5) : args[at + 1]
  if (at >= 0 && !to) throw new Error('--to needs a number: --to <your Linedesk number>')
  const rest = at < 0 ? args : args.filter((_, i) => i !== at && !(args[at] === '--to' && i === at + 1))
  return { to, fast: rest.includes('--fast'), name: rest.find(a => !a.startsWith('--')) ?? 'leak' }
}

/** The number to dial when none is given: the install's only Linedesk number; otherwise says what to pass. */
export async function defaultNumber(api: ApiClient): Promise<string> {
  const { data } = await api.run(callListNumbers, {})
  const numbers = (data as { numbers: string[] }).numbers
  if (numbers.length === 1) return numbers[0]!
  if (!numbers.length) throw new Error('This install has no Linedesk number yet. Add one in onboarding or Settings › Phone numbers, or pass --to <number>.')
  throw new Error(`This install has ${numbers.length} Linedesk numbers (${numbers.join(', ')}). Pass --to <your Linedesk number>.`)
}

/** What went wrong in words that say what to do; anything else as it came. */
export function explain(e: unknown): unknown {
  if (!(e instanceof ActionError)) return e
  if (e.status === 401) return new Error("AGENT_API_TOKEN does not match the API's. Use the same value as the API's .env.")
  if (e.action === 'call.start' && e.status === 409 && /no workspace for number/.test(e.message)) {
    return new Error('No workspace has this number. Pass --to <your Linedesk number>.')
  }
  return e
}

async function main() {
  const { to: given, fast, name } = parseArgs(process.argv.slice(2))
  if (!Object.hasOwn(simScripts, name)) {
    throw new Error(`unknown script "${name}". Available: ${Object.keys(simScripts).join(', ')}`)
  }
  const api = apiClientFromEnv()
  try {
    await playScript(api, simScripts[name as keyof typeof simScripts], {
      to: given ?? process.env.SIM_TO_NUMBER ?? (await defaultNumber(api)),
      wait: fast ? async () => {} : sleep,
      log: console.log,
    })
  } catch (e) {
    throw explain(e)
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) runScript(main)
