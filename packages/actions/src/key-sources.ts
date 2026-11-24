// What the voice agent reports at call.finish for a white-label own-keys call (S7, partner-keys.ts): per stage whose
// key served it. Its own file with no imports of the registry, so calls.ts can use it without an import cycle.
import { z } from 'zod'

/** What the agent reports at call.finish: per stage, whose key served it. */
export const KEY_SOURCES = ['partner', 'install'] as const
export type KeySource = (typeof KEY_SOURCES)[number]
export const keySourcesInput = z
  .object({
    stt: z.enum(KEY_SOURCES).optional(),
    llm: z.enum(KEY_SOURCES).optional(),
    tts: z.enum(KEY_SOURCES).optional(),
    realtime: z.enum(KEY_SOURCES).optional(),
  })
  .strict()
export type KeySources = z.infer<typeof keySourcesInput>

/**
 * Whether a call's report confirms it ran fully on the partner's keys: the stages of its pipeline are all reported and
 * all `partner` (three stages: speech, model and voice; realtime: the realtime model). Anything missing: not confirmed.
 */
export function keysConfirmed(sources: KeySources | null | undefined, pipeline: 'three_stage' | 'realtime'): boolean {
  if (!sources) return false
  const needed: (keyof KeySources)[] = pipeline === 'realtime' ? ['realtime'] : ['stt', 'llm', 'tts']
  const reported = Object.values(sources)
  return needed.every(s => sources[s] === 'partner') && reported.every(v => v === 'partner')
}
