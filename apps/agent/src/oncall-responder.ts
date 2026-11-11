// The test on-call phone for the live warm-transfer test: calls to the test on-call number reach a room
// whose job metadata names this responder (setup-oncall-test.ts), so the worker plays the on-call person
// instead of the business's assistant. It listens to the briefing, says yes (and presses 1), then says
// GREETING_LINE to the caller and hangs up. Nothing is written to the API: this is not a business call.
import type { JobContext } from '@livekit/agents'
import { type RemoteParticipant, RoomEvent } from '@livekit/rtc-node'
import type { AgentConfig } from './config.ts'
import { waitForCounterpart } from './counterpart.ts'
import { actOnCall, onCallLines, publishVoice, type SimulatedAnswer, simulatedAnswers } from './on-call-dialer.ts'

export const ONCALL_RESPONDER_SOURCE = 'oncall-responder'

/** The responder's job metadata, as setup-oncall-test writes it into the dispatch rule. */
export type OnCallResponderMetadata = { source: typeof ONCALL_RESPONDER_SOURCE; answer: SimulatedAnswer }

/** A responder hangs up by itself after this long, whatever happens on the line. */
export const RESPONDER_LIMIT_MS = 3 * 60_000

export function parseOnCallResponderMetadata(metadata: string): OnCallResponderMetadata | null {
  try {
    const parsed = JSON.parse(metadata) as { source?: unknown; answer?: unknown }
    if (parsed.source !== ONCALL_RESPONDER_SOURCE) return null
    const answer = simulatedAnswers.find(a => a === parsed.answer)
    return answer ? { source: ONCALL_RESPONDER_SOURCE, answer } : null
  } catch {
    return null
  }
}

/** A caller ID for the log: only its last four digits, enough to tell which number called. */
export const maskedNumber = (number: string | undefined) =>
  number && /\d{4}$/.test(number) ? `…${number.slice(-4)}` : 'an unknown number'

export async function runOnCallResponder(ctx: JobContext, { answer }: OnCallResponderMetadata, config: AgentConfig) {
  const hangUp = async () => {
    await ctx.deleteRoom().catch(() => {})
  }
  const limit = setTimeout(() => void hangUp(), RESPONDER_LIMIT_MS)
  limit.unref()
  ctx.addShutdownCallback(async () => clearTimeout(limit))
  const lines = await onCallLines(config, answer)
  const phone = await waitForCounterpart(ctx)
  console.log(`on-call responder (${answer}): answered a call from ${maskedNumber(phone.attributes['sip.phoneNumber'])}`)
  // The transfer side hung up (declined, no decision, or the bridge ended): end the room with it.
  ctx.room.on(RoomEvent.ParticipantDisconnected, (participant: RemoteParticipant) => {
    if (participant.identity === phone.identity) void hangUp()
  })
  const source = await publishVoice(ctx.room, lines)
  await actOnCall(ctx.room, source, answer, lines, { hangUp, pressOne: true })
}
