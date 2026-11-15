// One reply at a time on a realtime call (LIN-249). OpenAI Realtime answers the caller by itself (server VAD with
// `create_response`), and we ask it for replies too (the greeting, fixed lines, a nudge after a tool, the framework's
// reply to a tool result): each is a `response.create`. Sent while the model is still answering, or in the moment the
// caller stops talking and the server starts its own reply, OpenAI refuses it with
// `conversation_already_has_active_response`. The framework only waits for the caller to stop talking, which is exactly
// that moment: a greeting asked for while the caller says "Hello?" collided with the model's own answer to it.
// The gate follows the server's events and holds our request until no reply runs and none is about to start.

/** How long after the caller stopped (or a turn was committed) the server's own reply may still start. */
export const AUTO_REPLY_GRACE_MS = 1500
/** Never hold a request longer than this: a reply whose end we missed must not silence the call. */
export const MAX_REPLY_WAIT_MS = 15_000

type ServerEvent = {
  type?: string
  response?: { metadata?: Record<string, unknown> | null } | null
}
type ClientEvent = {
  type?: string
  session?: { audio?: { input?: { turn_detection?: { create_response?: unknown } | null } } }
}

export type RealtimeReplyGate = {
  /** Every client event the session sends (openai_client_event_queued). */
  sent(event: ClientEvent): void
  /** Every server event the session receives (openai_server_event_received). */
  received(event: ServerEvent): void
  /** A reply runs, or the server is about to start its own. */
  busy(): boolean
  /** Resolves once no reply runs and none is about to start (at most MAX_REPLY_WAIT_MS); rejects when aborted. */
  whenFree(signal?: AbortSignal): Promise<void>
  /** How many replies we asked for so far (response.create sent). */
  asked(): number
  /** How many replies the model started by itself so far (answering a turn of the caller). */
  serverReplies(): number
  /** Called with each reply that starts: `byServer` when the model started it itself (not asked by us). */
  onReply(listener: (byServer: boolean) => void): () => void
}

export function realtimeReplyGate({
  graceMs = AUTO_REPLY_GRACE_MS,
  maxWaitMs = MAX_REPLY_WAIT_MS,
  now = Date.now,
}: {
  graceMs?: number
  maxWaitMs?: number
  now?: () => number
} = {}): RealtimeReplyGate {
  let replying = false
  let autoUntil = 0
  // The server answers turns by itself until a session.update turns it off (realtime-lines.ts) and on again.
  let autoReplies = true
  let asked = 0
  let serverReplies = 0
  const wakers = new Set<() => void>()
  const listeners = new Set<(byServer: boolean) => void>()
  const wake = () => {
    for (const w of [...wakers]) w()
  }
  const busy = () => replying || now() < autoUntil

  return {
    sent(event) {
      const create =
        event.type === 'session.update' ? event.session?.audio?.input?.turn_detection?.create_response : undefined
      if (typeof create === 'boolean') autoReplies = create
      if (event.type === 'response.create') asked++
    },
    received(event) {
      switch (event.type) {
        case 'input_audio_buffer.speech_stopped':
        case 'input_audio_buffer.committed':
          if (autoReplies) autoUntil = now() + graceMs
          break
        case 'response.created': {
          replying = true
          autoUntil = 0
          const byServer = !event.response?.metadata?.client_event_id
          if (byServer) serverReplies++
          for (const l of [...listeners]) l(byServer)
          break
        }
        case 'response.done':
          replying = false
          wake()
          break
      }
    },
    busy,
    asked: () => asked,
    serverReplies: () => serverReplies,
    whenFree(signal) {
      const deadline = now() + maxWaitMs
      return new Promise<void>((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout> | undefined
        const done = (error?: Error) => {
          clearTimeout(timer)
          wakers.delete(check)
          signal?.removeEventListener('abort', aborted)
          if (error) reject(error)
          else resolve()
        }
        const aborted = () => done(new Error('generateReply aborted'))
        function check() {
          clearTimeout(timer)
          if (signal?.aborted) return aborted()
          const t = now()
          if (!busy() || t >= deadline) return done()
          // Woken by response.done; while only a server reply is expected, look again when its grace ends.
          timer = setTimeout(check, Math.max(1, Math.min(deadline, replying ? deadline : autoUntil) - t))
        }
        signal?.addEventListener('abort', aborted, { once: true })
        wakers.add(check)
        check()
      })
    },
    onReply(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

/** The realtime session as far as the gate needs it. */
export type GatedSession = {
  on(event: 'openai_client_event_queued' | 'openai_server_event_received', listener: (event: object) => void): unknown
  generateReply(instructions?: string, options?: { signal?: AbortSignal }): Promise<unknown>
}

/**
 * Puts the gate in front of the session's generateReply (every `response.create` asked for, ours and the
 * framework's), fed by the session's own events. Returns the gate.
 */
export function gateReplies(session: GatedSession, gate: RealtimeReplyGate = realtimeReplyGate()): RealtimeReplyGate {
  session.on('openai_client_event_queued', event => gate.sent(event))
  session.on('openai_server_event_received', event => gate.received(event))
  const generateReply = session.generateReply.bind(session)
  session.generateReply = async (instructions, options = {}) => {
    if (gate.busy()) await gate.whenFree(options.signal)
    return generateReply(instructions, options)
  }
  return gate
}
