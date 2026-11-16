// A slow tool (a lookup in the business's system, the calendar) can take seconds. The tool descriptions ask the model
// to say a short filler in the same reply, but it often leaves it out: the caller then heard only silence (LIN-341).
// So each slow tool gets a parameter, say_while_waiting: one short sentence the model writes with the call, about what it
// looks up, in the language of the call. When the tool is still running a moment after it started and the assistant
// said nothing in that reply, the agent says that sentence (at most once per caller turn). When it takes seconds, the
// agent says a second one the model wrote with the call, say_if_slow ("This is taking a little longer, I'm still on
// it."), and again every few seconds while the tool still runs, so the caller always knows. LiveKit frees the speech queue before it waits for a reply's tools, so the line plays while the tool runs,
// in both pipelines (the three stages say it with the voice provider, a realtime call plays it in the model's voice).
import { type llm, voice } from '@livekit/agents'
import { z } from 'zod'
import { type Reply, saidWords } from './hang-up.ts'

/** How long a slow tool may run before the filler is said: a quick answer needs none. */
export const FILLER_AFTER_MS = 700

/** When a slow tool still runs this long, the caller hears that it takes longer; then again every STILL_EVERY_MS. */
export const STILL_AFTER_MS = 4000
export const STILL_EVERY_MS = 8000
/** The agent or the caller still speaks when the long-wait sentence is due: try again this much later. */
const STILL_RETRY_MS = 1000

/** The parameters of each slow tool with the sentences said while it runs (rule 11: their wording was approved). */
export const FILLER_PARAM = 'say_while_waiting'
export const STILL_PARAM = 'say_if_slow'
const fillerParams = {
  [FILLER_PARAM]: z
    .string()
    .nullish()
    .describe(
      'One short sentence the caller hears if this takes a moment: what you are checking, in the language of the call, like "Let me check the times for Tuesday." Not a question.',
    ),
  [STILL_PARAM]: z
    .string()
    .nullish()
    .describe(
      'One short sentence the caller hears if this takes several seconds, in the language of the call, like "This is taking a little longer, I\'m still on it." Not a question.',
    ),
}

export type FillerTimes = { afterMs?: number; stillAfterMs?: number; stillEveryMs?: number }

/** The tools that wait on another system; the others answer at once or speak themselves (collection steps, transfer_call). */
export const isSlowTool = (name: string) =>
  name.startsWith('lookup_') ||
  ['find_slots', 'book_appointment', 'cancel_appointment', 'reschedule_appointment'].includes(name)

/** The session, as far as the filler needs it. */
export type FillerSession = {
  readonly agentState: string
  readonly userState: string
  on(
    event: voice.AgentSessionEventTypes.ConversationItemAdded,
    listener: (ev: { item: { type: string; role?: string } }) => void,
  ): unknown
}

/**
 * Returns `started(reply, running, lines)`, called when a slow tool of `reply` starts with the sentences the model wrote
 * for the wait; `running()` is false once it is done. `say` says one (fixedLineSpeaker: in either pipeline).
 */
export function toolFiller(session: FillerSession, say: (line: string) => Promise<unknown>, times: FillerTimes = {}) {
  const { afterMs = FILLER_AFTER_MS, stillAfterMs = STILL_AFTER_MS, stillEveryMs = STILL_EVERY_MS } = times
  let saidSinceCaller = false
  const replies = new WeakSet<object>()
  session.on(voice.AgentSessionEventTypes.ConversationItemAdded, ({ item }) => {
    if (item.type === 'message' && item.role === 'user') saidSinceCaller = false
  })
  // Its words still play, or the caller talks: nothing on top of them.
  const quiet = () => session.agentState !== 'speaking' && session.userState !== 'speaking'
  const sayLine = (text: string) =>
    say(text).catch(e => console.warn(`could not say the filler: ${e instanceof Error ? e.message : String(e)}`))
  return (reply: Reply, running: () => boolean, lines: { waiting?: string | null; slow?: string | null }) => {
    // Several slow tools in one reply: one filler.
    if (replies.has(reply)) return
    replies.add(reply)
    const waiting = lines.waiting?.trim()
    const slow = lines.slow?.trim()
    // No sentence from the model: nothing to say.
    if (waiting)
      setTimeout(() => {
        if (!running() || saidSinceCaller || saidWords(reply) || !quiet()) return
        saidSinceCaller = true
        sayLine(waiting)
      }, afterMs).unref?.()
    if (slow) {
      const stillAt = (ms: number) =>
        setTimeout(() => {
          if (!running()) return
          if (!quiet()) return stillAt(STILL_RETRY_MS)
          sayLine(slow)
          stillAt(stillEveryMs)
        }, ms).unref?.()
      stillAt(stillAfterMs)
    }
  }
}

// biome-ignore lint/suspicious/noExplicitAny: tools of different parameter types in one map
type Tools = Record<string, llm.AnonFunctionTool<any, any, any>>

/** The tools, each slow one with the say_while_waiting and say_if_slow parameters; the tool itself never gets them. */
export function withFillers(tools: Tools, started: ReturnType<typeof toolFiller>): Tools {
  return Object.fromEntries(
    Object.entries(tools).map(([name, tool]) => {
      if (!isSlowTool(name)) return [name, tool]
      const execute = tool.execute.bind(tool)
      const parameters = tool.parameters as z.ZodObject
      return [
        name,
        {
          ...tool,
          parameters: parameters.extend(fillerParams),
          execute: async (args: Record<string, unknown>, opts: llm.ToolOptions) => {
            const { [FILLER_PARAM]: waiting, [STILL_PARAM]: slow, ...rest } = args ?? {}
            const text = (v: unknown) => (typeof v === 'string' ? v : null)
            let running = true
            started(opts.ctx.speechHandle, () => running, { waiting: text(waiting), slow: text(slow) })
            try {
              return await execute(rest, opts)
            } finally {
              running = false
            }
          },
        },
      ]
    }),
  )
}
