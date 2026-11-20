// A realtime call's first connection to the model (LIN-634). On staging about one realtime call in fifteen (12 of ~170,
// 2026-11-12 to 11-20) had its first WebSocket to OpenAI hang until LiveKit's 10 s connect timeout; the next try
// connected at once. The greeting asked for meanwhile timed out with it, and the caller heard nothing until the silence
// reminder a minute later. Now the connection gets REALTIME_CONNECT_TIMEOUT_MS, and the call goes on without the
// model when it does not come up by then: on the three stages when the install has them (the worker), else on the
// model's next try, greeted only once it is connected.

/**
 * How long the realtime model's WebSocket may take to open: LiveKit's connect timeout for it (createRealtimePipeline),
 * and what the call waits before it goes on without it. Opening it from staging took 175–293 ms (25 tries,
 * 2026-11-20); the calls that failed never opened at all. 4 s is over ten times the slowest open, and on a fallback the
 * caller still hears the greeting about 5–6 s after pickup.
 */
export const REALTIME_CONNECT_TIMEOUT_MS = 4_000

/**
 * The call's own deadline on top of it: LiveKit reports the timeout first (a voice failure, as before); this only
 * catches a connection that neither opens nor fails.
 */
export const REALTIME_CONNECT_DEADLINE_MS = REALTIME_CONNECT_TIMEOUT_MS + 1_000

/** How the first connection went: open, failed (an error, or nothing by the deadline), or the session closed first. */
export type FirstConnection = 'connected' | 'failed' | 'closed'

/**
 * Follows a realtime session's first connection. `start` arms the deadline (when the model's session exists, so its
 * first try is under way); `connected`, `failed` and `closed` report what happened. `first` settles once: with the
 * first of them, or `failed` at the deadline. `later` settles true once the model is connected, also on a later try,
 * and false when the session closed before.
 */
export function firstConnection(deadlineMs = REALTIME_CONNECT_DEADLINE_MS) {
  let settleFirst: (outcome: FirstConnection) => void = () => {}
  let settleLater: (open: boolean) => void = () => {}
  const first = new Promise<FirstConnection>(resolve => (settleFirst = resolve))
  const later = new Promise<boolean>(resolve => (settleLater = resolve))
  let timer: ReturnType<typeof setTimeout> | null = null
  let settled = false
  const settle = (outcome: FirstConnection) => {
    if (timer) clearTimeout(timer)
    settled = true
    settleFirst(outcome)
  }
  return {
    first,
    later,
    start() {
      if (timer || settled) return
      timer = setTimeout(() => settle('failed'), deadlineMs)
      timer.unref?.()
    },
    connected() {
      settle('connected')
      settleLater(true)
    },
    failed() {
      settle('failed')
    },
    closed() {
      settle('closed')
      settleLater(false)
    },
  }
}
