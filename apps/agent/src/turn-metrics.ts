// One log line per measured stage of a reply, so the time a caller waits can be split into
// end-of-turn detection, the LLM's first token and the voice's first audio.
import { voice } from '@livekit/agents'

type Metrics = { type: string } & Record<string, unknown>

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
