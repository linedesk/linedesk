// A caller the assistant does not answer hears one short line in the assistant's voice before the agent hangs up,
// never silence: over the workspace's limit of calls at once (`busy`) or its monthly spending cap (`overCap`; the API
// filed both as missed with a callback), or a blocked number (filed in Spam).
import type { Room } from '@livekit/rtc-node'
import type { CallSession } from './call-session.ts'
import type { AgentConfig } from './config.ts'
import { createGreetingCache, type GreetingAudio, greetingKey, synthesize } from './greeting-cache.ts'
import { publishVoice, speak } from './on-call-dialer.ts'
import { createTts, greetingVoice } from './pipeline.ts'

export const BUSY_LINE = 'Sorry, all our lines are busy right now. Please call back in a few minutes.'
/** Not "call back in a few minutes": the cap holds until next month, and the team has the number to call back. */
export const OVER_CAP_LINE = "Sorry, we can't take your call right now. We'll call you back as soon as we can."
/** A blocked number (filed in Spam): still a word before the line goes dead, never silence. */
export const BLOCKED_LINE = "Sorry, we can't take your call. Goodbye."

/** Longest the caller is kept for the line, synthesis included; then the call ends anyway. */
export const BUSY_LINE_MAX_MS = 12_000

const lines = createGreetingCache()

/** A fixed line in the assistant's voice: synthesized once per voice and kept on disk like the greeting. */
export async function lineAudio(config: AgentConfig, call: Pick<CallSession, 'assistant'>, text: string): Promise<GreetingAudio> {
  const voice = call.assistant?.voice
  const key = greetingKey({ ...greetingVoice(config, call), text })
  const cached = await lines.get(key)
  if (cached) return cached
  const audio = await synthesize(createTts(config.tts, voice), text)
  void lines.put(key, audio).catch(() => {})
  return audio
}

/** What a caller the assistant does not answer hears: over the spending cap, busy, or a blocked number. */
export function unansweredLine(call: Pick<CallSession, 'busy' | 'overCap'>): string {
  if (call.overCap) return OVER_CAP_LINE
  if (call.busy) return BUSY_LINE
  return BLOCKED_LINE
}

/** Plays `text` into the room; resolves when it has played, failed, or BUSY_LINE_MAX_MS passed. Never throws. */
export async function playLine(room: Room, config: AgentConfig, call: Pick<CallSession, 'assistant' | 'callId'>, text: string, maxMs = BUSY_LINE_MAX_MS) {
  const played = (async () => {
    const audio = await lineAudio(config, call, text)
    await speak(await publishVoice(room, [audio]), audio)
  })()
  const cap = new Promise<void>(resolve => setTimeout(resolve, maxMs).unref?.())
  await Promise.race([played, cap]).catch(e => console.warn(`line for call ${call.callId} not played: ${e instanceof Error ? e.message : String(e)}`))
}
