// A slow tool (a lookup in the business's system, the calendar) can take seconds. The tool descriptions ask the model
// to say a short filler in the same reply, but it often leaves it out: the caller then heard only silence (LIN-341).
// So each slow tool gets a parameter, say_while_waiting: one short sentence the model writes with the call, about what it
// looks up, in the language of the call. When the tool is still running a moment after it started and the assistant
// said nothing in that reply, the agent says that sentence (at most once per caller turn). When it takes seconds, the
// agent says the fixed line of the call's language once (spokenLines stillChecking, "This is taking a little longer,
// I'm still on it.", LIN-359), so the caller knows (a second one would come after the cut-off at TOOL_MAX_WAIT_MS).
// LiveKit frees the speech queue before it waits for a reply's tools, so the line plays while the tool runs, in both
// pipelines (the three stages say it with the voice provider, a realtime call plays it in the model's voice).
// No tool of these makes the caller wait longer than TOOL_MAX_WAIT_MS: then the model hears it did not finish.
// While one runs, what the caller says starts no reply of its own (CallAgent): such a reply had no answer yet and made
// one up (LIN-359).
import { TOOL_MAX_WAIT_MS } from '@linedesk/actions'
import { type llm, voice } from '@livekit/agents'
import { z } from 'zod'
import { type Reply, saidWords } from './hang-up.ts'

/** How long a slow tool may run before the filler is said: a quick answer needs none. */
export const FILLER_AFTER_MS = 700

/** When a slow tool still runs this long, the caller hears once that it takes longer. */
export const STILL_AFTER_MS = 4000
/** The agent or the caller still speaks when the long-wait sentence is due: try again this much later. */
const STILL_RETRY_MS = 1000

/** The parameter of each slow tool with the sentence said while it runs (rule 11: its wording was approved). */
export const FILLER_PARAM = 'say_while_waiting'
const fillerParams = {
  [FILLER_PARAM]: z
    .string()
    .nullish()
    .describe(
      'One short sentence the caller hears if this takes a moment: what you are checking, in the language of the call, like "Let me check the times for Tuesday." Not a question.',
    ),
}

/**
 * What the model gets when a slow tool runs longer than TOOL_MAX_WAIT_MS (rule 11: wording approved). A booking may
 * still go through after that, so the model must not say it worked, nor that it failed for sure.
 */
export const TOO_SLOW_REPLY =
  'This took too long, and it is not clear whether it worked. Do not say it worked. Tell the caller you could not finish that right now, and offer to take a message.'

export type FillerTimes = { afterMs?: number; stillAfterMs?: number }
/** Called when a slow tool starts (toolFiller). */
export type ToolStarted = (reply: Reply, running: () => boolean, lines: { waiting?: string | null }) => void
/** `stillLine`: the fixed long-wait line in the call's language now. */
export type FillerOptions = FillerTimes & { stillLine?: () => string }

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
 * `started.busy()`: whether a slow tool still runs.
 */
export function toolFiller(
  session: FillerSession,
  say: (line: string) => Promise<unknown>,
  options: FillerOptions = {},
) {
  const { afterMs = FILLER_AFTER_MS, stillAfterMs = STILL_AFTER_MS, stillLine } = options
  const runningTools = new Set<() => boolean>()
  const busy = () => {
    for (const running of runningTools) if (!running()) runningTools.delete(running)
    return runningTools.size > 0
  }
  let saidSinceCaller = false
  const replies = new WeakSet<object>()
  session.on(voice.AgentSessionEventTypes.ConversationItemAdded, ({ item }) => {
    if (item.type === 'message' && item.role === 'user') saidSinceCaller = false
  })
  // Its words still play, or the caller talks: nothing on top of them.
  const quiet = () => session.agentState !== 'speaking' && session.userState !== 'speaking'
  const sayLine = (text: string) =>
    say(text).catch(e => console.warn(`could not say the filler: ${e instanceof Error ? e.message : String(e)}`))
  const started: ToolStarted = (reply, running, lines) => {
    runningTools.add(running)
    // Several slow tools in one reply: one filler.
    if (replies.has(reply)) return
    replies.add(reply)
    const waiting = lines.waiting?.trim()
    const slow = stillLine?.()
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
        }, ms).unref?.()
      stillAt(stillAfterMs)
    }
  }
  return Object.assign(started, { busy })
}

/**
 * The assistant of a call. While a slow tool runs (`busy`), what the caller says ("I'll wait", "thanks") goes into the
 * conversation and the transcript but starts no reply: that reply had no answer yet and made one up (LIN-359). The
 * tool's reply comes next; the caller's words are in view from then on.
 */
export class CallAgent extends voice.Agent {
  readonly #busy: () => boolean

  // biome-ignore lint/suspicious/noExplicitAny: the agent's user data is not used
  constructor(options: voice.AgentOptions<any>, busy: () => boolean) {
    super(options)
    this.#busy = busy
  }

  override async onUserTurnCompleted(_chatCtx: llm.ChatContext, message: llm.ChatMessage): Promise<void> {
    if (!this.#busy()) return
    this._chatCtx.items.push(message)
    this.session._conversationItemAdded(message)
    throw new voice.StopResponse()
  }
}

// biome-ignore lint/suspicious/noExplicitAny: tools of different parameter types in one map
type Tools = Record<string, llm.AnonFunctionTool<any, any, any>>

/**
 * The tools, each slow one with the say_while_waiting parameter (the tool itself never gets it) and
 * cut off after `maxWaitMs`: the caller never waits longer than that for another system. While one runs the caller can't
 * interrupt the turn: else a "hello?" during the wait cancels the tool, and the assistant never hears the answer.
 */
export function withFillers(tools: Tools, started: ToolStarted, maxWaitMs = TOOL_MAX_WAIT_MS): Tools {
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
            const { [FILLER_PARAM]: waiting, ...rest } = args ?? {}
            const text = (v: unknown) => (typeof v === 'string' ? v : null)
            opts.ctx.disallowInterruptions()
            let running = true
            started(opts.ctx.speechHandle, () => running, { waiting: text(waiting) })
            let timer: ReturnType<typeof setTimeout> | undefined
            const tooSlow = new Promise<string>(resolve => {
              timer = setTimeout(() => {
                console.warn(`tool ${name} took longer than ${maxWaitMs} ms: the caller is told it did not finish`)
                resolve(TOO_SLOW_REPLY)
              }, maxWaitMs)
            })
            try {
              return await Promise.race([execute(rest, opts), tooSlow])
            } finally {
              running = false
              clearTimeout(timer)
            }
          },
        },
      ]
    }),
  )
}
