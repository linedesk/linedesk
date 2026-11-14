// An empty reply of the language model (no text, no tool call) leaves the caller in silence: the session only speaks
// again when the caller does, or when the silence reminder comes. It happens most right after a tool result, such as
// a collection step that handed back (LIN-175). The assistant is asked again at once, once.
import { voice } from '@livekit/agents'

/** How long after the empty reply the session gets to settle back to listening before it is asked again. */
export const RETRY_AFTER_MS = 250

/** Worded unlike the request that came back empty, so the model does not answer it the same way. */
export const EMPTY_REPLY_RETRY =
  'Your last reply was empty and the caller heard nothing. Say your next line to the caller now: answer what they asked or wanted, or ask for what you still need.'

type Session = Pick<voice.AgentSession, 'on' | 'agentState' | 'userState'> & {
  generateReply(options: { instructions: string }): unknown
}
type LlmMetrics = { type: string; ttftMs?: number; cancelled?: boolean }

/**
 * Asks the assistant once more, right away, when a reply of the language model came back empty while the caller is
 * not talking. The retry's own reply is not retried: if that is empty too, the silence reminder takes over.
 */
export function retryEmptyReplies(session: Session, waitMs = RETRY_AFTER_MS) {
  let retrying = false
  session.on(voice.AgentSessionEventTypes.MetricsCollected, ({ metrics }: { metrics: LlmMetrics }) => {
    if (metrics.type !== 'llm_metrics' || metrics.cancelled) return
    const wasRetry = retrying
    retrying = false
    if ((metrics.ttftMs ?? 0) >= 0 || wasRetry) return
    setTimeout(() => {
      if (session.agentState !== 'listening' || session.userState === 'speaking') return
      // The call may have ended meanwhile: a closing session throws, and a throw in a timer would end the whole job.
      try {
        retrying = true
        session.generateReply({ instructions: EMPTY_REPLY_RETRY })
      } catch {
        retrying = false
      }
    }, waitMs).unref?.()
  })
}
