// A caller the assistant does not answer hears one short line in the assistant's voice before the agent hangs up,
// never silence: over the workspace's limit of calls at once (`busy`) or its monthly spending cap (`overCap`; the API
// filed both as missed with a callback), or a blocked number (filed in Spam).
import { mainLanguageOf, spokenLines } from '@linedesk/actions'
import type { Room } from '@livekit/rtc-node'
import type { CallSession } from './call-session.ts'
import { createGreetingCache, type GreetingAudio, greetingKey, synthesize } from './greeting-cache.ts'
import { publishVoice, speak } from './on-call-dialer.ts'
import type { LineVoice } from './pipeline.ts'

// The lines in English; the call says them in the assistant's main language (spokenLines).
export const BUSY_LINE = spokenLines('en').busy
/** Not "call back in a few minutes": the cap holds until next month, and the team has the number to call back. */
export const OVER_CAP_LINE = spokenLines('en').overCap
/** A blocked number (filed in Spam): still a word before the line goes dead, never silence. */
export const BLOCKED_LINE = spokenLines('en').blocked

/** Longest the caller is kept for the line, synthesis included; then the call ends anyway. */
export const BUSY_LINE_MAX_MS = 12_000

const lines = createGreetingCache()

/** A fixed line in the call's line voice (lineVoiceOf): synthesized once per voice and text and kept on disk like the greeting. */
export async function lineAudio(voice: LineVoice, text: string): Promise<GreetingAudio> {
  const key = greetingKey({ ...voice.key, text })
  const cached = await lines.get(key)
  if (cached) return cached
  const audio = await synthesize(voice.tts(), text)
  void lines.put(key, audio).catch(() => {})
  return audio
}

/** What a caller the assistant does not answer hears: over the spending cap, busy, or a blocked number. */
export function unansweredLine(call: Pick<CallSession, 'busy' | 'overCap' | 'assistant'>): string {
  const lines = spokenLines(mainLanguageOf(call.assistant?.languages))
  if (call.overCap) return lines.overCap
  if (call.busy) return lines.busy
  return lines.blocked
}

/** Plays `text` into the room; resolves when it has played, failed, or BUSY_LINE_MAX_MS passed. Never throws. */
export async function playLine(room: Room, voice: LineVoice, call: Pick<CallSession, 'callId'>, text: string, maxMs = BUSY_LINE_MAX_MS) {
  const played = (async () => {
    const audio = await lineAudio(voice, text)
    await speak(await publishVoice(room, [audio]), audio)
  })()
  const cap = new Promise<void>(resolve => setTimeout(resolve, maxMs).unref?.())
  await Promise.race([played, cap]).catch(e => console.warn(`line for call ${call.callId} not played: ${e instanceof Error ? e.message : String(e)}`))
}
