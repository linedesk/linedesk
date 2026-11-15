// Where the time of a reply goes on the three stages: one log line per measured stage (end-of-turn detection, the
// LLM's first token, the voice's first audio), and per reply the parts with the agent's own share (ReplyTimes), from
// the caller's last word (Flux's lastSpeakingTime) to the moment the reply starts playing.
import { voice } from '@livekit/agents'

type Metrics = { type: string; speechId?: string; cancelled?: boolean } & Record<string, unknown>

/**
 * One reply's time in milliseconds, split by where it went: end-of-turn detection, the model (until its first token;
 * a realtime model until its first audio), the voice (until its first audio; none on a realtime call) and the agent
 * itself (the rest until the audio plays). `at`: when the caller stopped speaking. A part that was not measured is left
 * out: the model's or the voice's (LiveKit reports -1, e.g. when the voice failed and the fallback voice spoke), and
 * then the agent's too, since the rest would hold the part not measured.
 */
export type ReplyTimes = { at: string; turnMs: number; modelMs?: number; voiceMs?: number; serverMs?: number; totalMs: number }

/** The log line for one metrics event, or null for the kinds that do not affect reply latency. */
export function describeMetrics(m: Metrics): string | null {
  const ms = (key: string) => `${Math.round(Number(m[key] ?? 0))} ms`
  if (m.type === 'eou_metrics')
    return `end of turn ${ms('endOfUtteranceDelayMs')} (transcript ${ms('transcriptionDelayMs')})`
  if (m.type === 'llm_metrics') return `llm first token ${ms('ttftMs')} (total ${ms('durationMs')})`
  if (m.type === 'tts_metrics') return `voice first audio ${ms('ttfbMs')}`
  return null
}

export function logTurnMetrics(session: voice.AgentSession, label: string) {
  session.on(voice.AgentSessionEventTypes.MetricsCollected, ({ metrics }) => {
    const line = describeMetrics(metrics as unknown as Metrics)
    if (line) console.log(`latency ${label}: ${line}`)
  })
}

/** A measured time in whole milliseconds; undefined for LiveKit's "not measured" (-1) or anything else not a time. */
const measured = (ms: number): number | undefined => (Number.isFinite(ms) && ms >= 0 ? Math.round(ms) : undefined)

type Pending = { speechEnd?: number; turnMs?: number; modelMs?: number; voiceMs?: number; playing?: number }

/**
 * Puts each reply's parts together on the three stages. `metrics` takes the session's metrics events (grouped by the
 * reply's speech id), `speaking` the moment the agent starts playing; a reply goes to `onReply` once its end of turn,
 * first token, first audio and playing are all known. A reply cut short (cancelled) gives none.
 */
export function cascadedReplyTimer(onReply: (reply: ReplyTimes) => void, now: () => number = Date.now) {
  const replies = new Map<string, Pending>()
  /** The reply whose end of turn came last: the next audio that plays is its. */
  let awaitingAudio: string | null = null
  const entry = (id: string) => replies.get(id) ?? replies.set(id, {}).get(id)!
  const complete = (id: string) => {
    const r = replies.get(id)
    if (!r || r.speechEnd === undefined || r.turnMs === undefined || r.modelMs === undefined || r.voiceMs === undefined || r.playing === undefined) return
    replies.delete(id)
    // No moment the caller stopped speaking (LiveKit reports 0 then): no total to put the parts in, so no reply time.
    if (!(r.speechEnd > 0)) return
    const totalMs = Math.round(r.playing - r.speechEnd)
    const turnMs = measured(r.turnMs)
    const modelMs = measured(r.modelMs)
    const voiceMs = measured(r.voiceMs)
    if (turnMs === undefined) return
    const parts = turnMs + (modelMs ?? 0) + (voiceMs ?? 0)
    // The parts never add up to more than the total: if they do, the reply was matched wrong (no reply time then).
    if (parts > totalMs) return
    onReply({
      at: new Date(r.speechEnd).toISOString(),
      turnMs,
      ...(modelMs !== undefined && { modelMs }),
      ...(voiceMs !== undefined && { voiceMs }),
      ...(modelMs !== undefined && voiceMs !== undefined && { serverMs: totalMs - parts }),
      totalMs,
    })
  }
  return {
    metrics(m: Metrics) {
      const id = m.speechId
      if (!id || m.cancelled) return
      if (m.type === 'eou_metrics') {
        const r = entry(id)
        r.speechEnd = Number(m.lastSpeakingTimeMs)
        r.turnMs = Number(m.endOfUtteranceDelayMs)
        awaitingAudio = id
      } else if (m.type === 'llm_metrics') entry(id).modelMs ??= Number(m.ttftMs)
      else if (m.type === 'tts_metrics') entry(id).voiceMs ??= Number(m.ttfbMs)
      else return
      complete(id)
    },
    speaking() {
      if (!awaitingAudio) return
      const id = awaitingAudio
      awaitingAudio = null
      entry(id).playing = now()
      complete(id)
    },
  }
}
