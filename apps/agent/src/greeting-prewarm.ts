// The greetings stored before the first call (LIN-679). A call plays its greeting from the store (greeting-cache.ts);
// one that is not there yet is made live by the voice provider and stored for the next call. In a burst of calls after
// a greeting changed, every call made it live at once and some callers waited over a minute (LIN-512). So the worker's
// main process asks the API every minute what each assistant a phone number answers with would greet with now
// (GET /v1/agent/greetings), builds each greeting text exactly as a call does, and stores the ones it does not have:
// at worker start, and within a minute of a save.
import { fillTemplate, mainLanguageOf, spokenLines, templateNames } from '@linedesk/actions'
import type { Assistant } from '@linedesk/db/types'
import type { ApiClient } from './api-client.ts'
import {
  type BusinessHours,
  callWantsRecording,
  inMainLanguage,
  withRecordingNotice,
  withWorkspaceLanguage,
} from './call-session.ts'
import { type CallConfig, configForAssistant, isRealtime, pipelineOfAssistant } from './config.ts'
import { createGreetingCache, greetingKey, synthesize } from './greeting-cache.ts'
import { createTts, greetingVoice, spokeWithBackup, talkingSpeedOf } from './pipeline.ts'
import { forHours } from './prompt.ts'

/**
 * A greeting longer than this is not made in advance (review of LIN-679): its first call makes it, as before. The
 * closure greeting's limit (CLOSURE_GREETING_MAX); greetings are a sentence or two.
 */
export const PREWARM_GREETING_MAX = 600

/** How often the worker asks for the greetings: a saved greeting is stored within this long. */
export const GREETING_PREWARM_MS = 60_000

/** One entry of GET /v1/agent/greetings: what call.start would send for this assistant now. */
export type GreetingEntry = {
  assistant: Assistant
  workspaceLanguage?: string | null
  recordingNotice?: string | null
  keepRecording?: boolean
  businessHours?: BusinessHours | null
}

/** What a call opens with: the assistant's greeting, else the fallback in its main language (worker.ts uses it too). */
export const openingOf = (assistant: Pick<Assistant, 'greeting' | 'languages'> | null | undefined) =>
  assistant?.greeting || spokenLines(mainLanguageOf(assistant?.languages)).fallbackGreeting

/**
 * The text a greeting is stored under: a greeting with caller details ({{name}}) without them, which is what a call
 * plays when the details are not there in time (worker.ts, greet).
 */
export const storedGreetingText = (opening: string) =>
  templateNames(opening).length ? fillTemplate(opening, null) : opening

/**
 * Every assistant a call of this entry can open with, as startCall and announceRecording build it: in its main
 * language, open or closed (the outside-hours greeting, or the closure's while one runs), with and without the
 * recording notice (a call says it only when it is recorded). Duplicates are left to the key.
 */
export function greetingVariants(entry: GreetingEntry): Assistant[] {
  const own = inMainLanguage(withWorkspaceLanguage(entry.assistant, entry.workspaceLanguage))
  if (!own) return []
  const closed: BusinessHours = entry.businessHours?.closure ? entry.businessHours : { openNow: false, summary: '' }
  const greeted = [forHours(own, null), forHours(own, closed)].filter((a): a is Assistant => a !== null)
  const recorded =
    entry.recordingNotice && callWantsRecording({ assistant: own, keepRecording: entry.keepRecording })
      ? greeted.map(a => withRecordingNotice(a, entry.recordingNotice)).filter((a): a is Assistant => a !== null)
      : []
  return [...greeted, ...recorded]
}

/** The greetings of `entries` on this install's voices: text, store key, and the assistant to make it with. */
export function greetingsToMake(entries: readonly GreetingEntry[], install: CallConfig) {
  const byKey = new Map<string, { key: string; text: string; assistant: Assistant; config: CallConfig }>()
  for (const entry of entries) {
    const config = configForAssistant(install, pipelineOfAssistant(entry.assistant), () => {})
    // A realtime model says the greeting itself: nothing is stored for it.
    if (isRealtime(config)) continue
    for (const assistant of greetingVariants(entry)) {
      const text = storedGreetingText(openingOf(assistant))
      if (text.length > PREWARM_GREETING_MAX) continue
      const key = greetingKey({ ...greetingVoice(config, { assistant }), text })
      if (!byKey.has(key)) byKey.set(key, { key, text, assistant, config })
    }
  }
  return [...byKey.values()]
}

/**
 * One round: asks the API, and makes and stores the greetings the store does not have, one after another (each takes
 * the voice provider about a second). Never throws: the next round tries again.
 */
export async function prewarmGreetings(
  api: Pick<ApiClient, 'greetings'>,
  loadConfig: () => Promise<CallConfig>,
  cache = createGreetingCache(),
  log: (line: string) => void = line => console.log(line),
) {
  try {
    if (!api.greetings) return
    const body = (await api.greetings()) as { greetings?: GreetingEntry[] } | null
    const entries = body?.greetings ?? []
    if (!entries.length) return
    const missing = []
    for (const greeting of greetingsToMake(entries, await loadConfig()))
      if (!cache.has(greeting.key)) missing.push(greeting)
    let made = 0
    for (const { key, text, assistant, config } of missing) {
      if (isRealtime(config)) continue
      const voice = createTts(
        config.tts,
        assistant.voice,
        mainLanguageOf(assistant.languages),
        talkingSpeedOf(assistant),
      )
      try {
        const audio = await synthesize(voice, text)
        // Made by the backup voice (the voice provider failed): not stored as the assistant's own greeting.
        if (spokeWithBackup(voice)) continue
        await cache.put(key, audio)
        made++
      } catch (e) {
        log(`greeting not stored in advance: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    if (missing.length) log(`greetings stored in advance: ${made} of ${missing.length} missing`)
  } catch (e) {
    log(`greetings not stored in advance: ${e instanceof Error ? e.message : String(e)}`)
  }
}

/** Runs prewarmGreetings now and every GREETING_PREWARM_MS, never two rounds at once. */
export function keepGreetingsStored(api: Pick<ApiClient, 'greetings'>, loadConfig: () => Promise<CallConfig>) {
  let running = false
  const round = async () => {
    if (running) return
    running = true
    try {
      await prewarmGreetings(api, loadConfig)
    } finally {
      running = false
    }
  }
  void round()
  setInterval(() => void round(), GREETING_PREWARM_MS).unref()
}
