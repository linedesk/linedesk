// Plays a scripted call through the real API, so the inbox shows a live call without any
// telephony or speech provider. Usage: pnpm --filter @callfront/agent simulate [script] [--fast]
import { pathToFileURL } from 'node:url'
import { apiClientFromEnv, type ApiClient } from './api-client.ts'
import { startCall } from './call-session.ts'
import { simScripts, type SimLine, type SimScript } from './sim-scripts.ts'

const FALLBACK_GREETING = 'Thanks for calling. How can I help?'
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
  const call = await startCall(api, { from: script.from, to })
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

async function main() {
  const args = process.argv.slice(2)
  const fast = args.includes('--fast')
  const name = args.find(a => !a.startsWith('--')) ?? 'leak'
  if (!Object.hasOwn(simScripts, name)) {
    throw new Error(`unknown script "${name}". Available: ${Object.keys(simScripts).join(', ')}`)
  }
  await playScript(apiClientFromEnv(), simScripts[name as keyof typeof simScripts], {
    to: process.env.SIM_TO_NUMBER ?? '+15035550142',
    wait: fast ? async () => {} : sleep,
    log: console.log,
  })
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(e => {
    console.error(e instanceof Error ? e.message : e)
    process.exit(1)
  })
}
