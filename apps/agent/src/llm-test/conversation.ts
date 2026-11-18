// One simulated call (LIN-391): the real system prompt and tools, the configured model, and a caller who says the
// case's lines (or an LLM playing the caller). Text only: no speech, no LiveKit session. It mirrors what the worker
// does around the model: the greeting as the first assistant message, up to MAX_TOOL_STEPS tool rounds per caller
// turn (the last one with tools off), no extra round after end_call (skipEndCallReplies) or after flag_urgent when
// the assistant already spoke (skipQuietToolReplies), the closing flow of end_call (closingFlow, LIN-358), one
// "go on" nudge after an empty reply (nudgeIfQuiet), and the language rule once the caller switched to another
// allowed language (spokenLanguageRule).
import { type Language, spokenLines } from '@linedesk/actions'
import { asksAnythingElse, asksCaller, closingFlow, END_CALL_ASKED, END_CALL_ENDS, withoutEndCall } from '../hang-up.ts'
import { MAX_TOOL_STEPS } from '../pipeline.ts'
import { buildInstructions, spokenLanguageRule } from '../prompt.ts'
import { connectingLine, notConnectedReply } from '../transfer.ts'
import { promisesUrgent } from '../urgent-promise.ts'
import type { ChatMessage, Model, ToolCall } from './model.ts'
import type { Setup } from './setups.ts'
import {
  buildTools,
  fakeToolOptions,
  isCollectTool,
  openAiTools,
  parseArgs,
  type SimOptions,
  stepResult,
} from './tools.ts'

/** What happened on the call, in order. `turn`: the caller turn it answers (0: the greeting). */
export type CallEvent =
  | { kind: 'assistant'; turn: number; text: string; response: number }
  | { kind: 'caller'; turn: number; text: string }
  | {
      kind: 'tool'
      turn: number
      name: string
      args: Record<string, unknown>
      raw: string
      result: string
      response: number
      error?: boolean
    }
  /** A fixed line the agent says itself (the greeting, "anything else?", the goodbye, the transfer's connecting line). */
  | { kind: 'line'; turn: number; text: string; why: string }
  | { kind: 'note'; turn: number; text: string }

export type Transcript = {
  events: CallEvent[]
  ended: boolean
  endedBy: 'end_call' | 'transfer' | 'caller' | null
  /** flag_urgent called, or the worker's guard would flag it (the assistant said it is flagged). */
  urgent: boolean
  /** The system prompt of the call (for the report of a failed run). */
  instructions: string
}

/** A caller turn: a line, optionally with the language it is in (the worker learns it from speech recognition). */
export type CallerTurn = string | { say: string; lang?: Language }

/** An LLM playing the caller, for open-ended cases. */
export type SimulatedCaller = { persona: string; goal: string; maxTurns?: number }

const NUDGE = 'Go on with the call: answer what the caller asked or wanted, or ask for what you still need.'
/** Tools whose result the caller need not hear when the assistant already spoke (worker.ts QUIET_TOOLS). */
const QUIET_TOOLS = new Set(['flag_urgent'])
/** transfer_call's answer to a second try (transfer-tool.ts). */
const TRANSFER_TRIED = 'You already tried to transfer this call. Take a message instead.'

export type RunOptions = { model: Model; callerModel?: Model; sim?: SimOptions }

export async function runCall(
  setup: Setup,
  script: { turns?: CallerTurn[]; caller?: SimulatedCaller },
  { model, callerModel, sim = {} }: RunOptions,
): Promise<Transcript> {
  const { tools, log, urgent } = buildTools(setup, sim)
  const toolList = openAiTools(tools)
  let spoken: Language | null = null
  const instructionsNow = () =>
    [
      buildInstructions(
        setup.assistant,
        setup.hours,
        setup.booking,
        setup.transfers,
        setup.caller,
        setup.timeZone,
        setup.now,
        setup.callerDetails,
        setup.lookups.length > 0,
        setup.teamLanguage,
      ),
      spoken ? spokenLanguageRule(setup.assistant, spoken) : null,
    ]
      .filter(Boolean)
      .join('\n\n')
  const t: Transcript = { events: [], ended: false, endedBy: null, urgent: false, instructions: instructionsNow() }
  const history: ChatMessage[] = []
  const closing = closingFlow()
  let ids = 0
  let responses = 0
  let transferTried = false
  /** Fixed lines said while a response's tools run: they go into the history after its tool results. */
  let afterTools: string[] = []
  const lines = spokenLines('en')

  const said = (turn: number, text: string, response: number) => {
    const id = `m${++ids}`
    t.events.push({ kind: 'assistant', turn, text, response })
    closing.assistantSaid(id, withoutEndCall(text))
    if (promisesUrgent(text)) t.urgent = true
    return id
  }
  const line = (turn: number, text: string, why: string, { duringTools = false } = {}) => {
    t.events.push({ kind: 'line', turn, text, why })
    if (duringTools) afterTools.push(text)
    else history.push({ role: 'assistant', content: text })
  }

  line(0, setup.greeting, 'greeting')
  closing.assistantSaid(`m${++ids}`, setup.greeting)

  /** The assistant's turn after the caller spoke: replies and tool rounds until it waits for the caller again. */
  async function assistantTurn(turn: number) {
    let nudged = false
    let nudgeNow = false
    for (let round = 0; round <= MAX_TOOL_STEPS; round++) {
      // The nudge is an instruction for that one reply (generateReply), not part of the conversation.
      const messages: ChatMessage[] = [
        { role: 'system', content: instructionsNow() },
        ...history,
        ...(nudgeNow ? [{ role: 'system', content: NUDGE } as const] : []),
      ]
      nudgeNow = false
      const { message } = await model.reply(messages, toolList, { toolsOff: round === MAX_TOOL_STEPS })
      const response = ++responses
      const text = message.content?.trim() ?? ''
      const calls = message.tool_calls ?? []
      if (!text && !calls.length) {
        // An empty reply: the worker asks once to go on (nudgeIfQuiet, retryEmptyReplies).
        if (nudged) return
        nudged = true
        nudgeNow = true
        t.events.push({ kind: 'note', turn, text: 'empty reply: nudged to go on' })
        continue
      }
      history.push({ role: 'assistant', content: text || null, ...(calls.length ? { tool_calls: calls } : {}) })
      const textIds = new Set<string>()
      if (text) textIds.add(said(turn, text, response))
      if (!calls.length) return
      let replyNext = false
      let endCall: 'ask' | 'ends' | null = null
      afterTools = []
      for (const call of calls) {
        const { result, next } = await runTool(call, turn, response, text, textIds)
        history.push({ role: 'tool', tool_call_id: call.id, content: result })
        if (call.function.name === 'end_call') endCall = endCall ?? (result === END_CALL_ENDS ? 'ends' : 'ask')
        if (next) replyNext = true
      }
      for (const fixed of afterTools) history.push({ role: 'assistant', content: fixed })
      if (endCall === 'ask' && !t.ended) {
        // The fixed question, unless the assistant just asked it or asked something else (askAnythingElse).
        if (!(text && (asksAnythingElse(text) || asksCaller(text)))) {
          closing.questionComing(textIds)
          line(turn, lines.anythingElse, 'end_call asks')
          closing.assistantSaid(`m${++ids}`, lines.anythingElse)
        }
      }
      if (endCall === 'ends' && !t.ended) {
        // hangUpWithGoodbye: words that ask the caller something keep the call going.
        if (text && asksCaller(text)) {
          t.events.push({ kind: 'note', turn, text: 'end_call after a question: the call goes on' })
        } else {
          line(turn, lines.goodbye, 'end_call hangs up')
          t.ended = true
          t.endedBy = 'end_call'
        }
      }
      if (t.ended || endCall) return
      if (!replyNext && text) return
    }
  }

  /** Runs one tool call; `next`: whether the model gets another round for its result. */
  async function runTool(
    call: ToolCall,
    turn: number,
    response: number,
    text: string,
    textIds: Set<string>,
  ): Promise<{ result: string; next: boolean }> {
    const name = call.function.name
    const raw = call.function.arguments ?? ''
    const record = (result: string, args: Record<string, unknown> = {}, error = false) => {
      t.events.push({ kind: 'tool', turn, name, args, raw, result, response, ...(error ? { error } : {}) })
      return result
    }
    const tool = tools[name]
    if (!tool)
      return {
        result: record(
          `Unknown function: ${name} - available tools: ${Object.keys(tools).sort().join(', ')}`,
          {},
          true,
        ),
        next: true,
      }
    const parsed = parseArgs(tool, raw)
    if (!parsed.ok) return { result: record(parsed.error, {}, true), next: true }
    const args = parsed.args
    if (name === 'end_call') {
      const step = closing.step(textIds)
      return { result: record(step === 'ask' ? END_CALL_ASKED : END_CALL_ENDS, args), next: false }
    }
    if (isCollectTool(name)) {
      const { result, value } = stepResult(name, sim.steps?.[name], setup)
      if (name === 'get_name' && value) log.confirmedName = value
      if (name === 'get_address' && value) log.confirmedAddress = value
      return { result: record(result, args), next: true }
    }
    if (name === 'transfer_call') {
      if (transferTried) return { result: record(TRANSFER_TRIED, args), next: true }
      transferTried = true
      const picked = (args.contacts as string[] | undefined)?.[0] ?? setup.transfers[0]?.name ?? 'someone'
      line(turn, connectingLine(lines, picked, null), 'transfer_call', { duringTools: true })
      if ((sim.transfer ?? 'not_connected') === 'connected') {
        record('(connected: the caller talks with the person now)', args)
        t.ended = true
        t.endedBy = 'transfer'
        // The tool returns nothing; the model is not asked again.
        return { result: '', next: false }
      }
      return { result: record(notConnectedReply(), args), next: true }
    }
    const result = String((await tool.execute(args, fakeToolOptions(call.id))) ?? '')
    if (name === 'flag_urgent') t.urgent = urgent.flagged || t.urgent
    record(result, args)
    // flag_urgent after words: no extra round (skipQuietToolReplies).
    return { result, next: !(QUIET_TOOLS.has(name) && text) }
  }

  const turns = script.turns ?? []
  const maxTurns = script.caller ? (script.caller.maxTurns ?? 8) : turns.length
  for (let i = 0; i < maxTurns && !t.ended; i++) {
    const turn = i + 1
    let say: string
    let lang: Language | undefined
    if (script.caller) {
      if (!callerModel) throw new Error('a simulated caller needs a caller model')
      const next = await callerLine(callerModel, script.caller, t)
      if (next === null) {
        t.events.push({ kind: 'note', turn, text: 'the caller hung up' })
        t.ended = true
        t.endedBy = 'caller'
        break
      }
      say = next
    } else {
      const entry = turns[i]!
      say = typeof entry === 'string' ? entry : entry.say
      lang = typeof entry === 'string' ? undefined : entry.lang
    }
    if (lang) spoken = lang === (setup.assistant.languages as { main?: string }).main ? null : lang
    t.events.push({ kind: 'caller', turn, text: say })
    history.push({ role: 'user', content: say })
    await assistantTurn(turn)
  }
  t.urgent = t.urgent || urgent.flagged
  return t
}

/** The simulated caller's next line, or null when they hang up. */
async function callerLine(model: Model, caller: SimulatedCaller, t: Transcript): Promise<string | null> {
  const said = t.events
    .flatMap(e =>
      e.kind === 'assistant' || e.kind === 'line'
        ? [`Assistant: ${e.text}`]
        : e.kind === 'caller'
          ? [`You: ${e.text}`]
          : [],
    )
    .join('\n')
  const reply = await model.complete(
    [
      {
        role: 'system',
        content: [
          'You play a caller on a phone call to a business, to test its AI phone assistant. Stay in character.',
          `Who you are: ${caller.persona}`,
          `What you want from this call: ${caller.goal}`,
          'Say only your next line, as you would speak it on the phone: one or two short sentences, no stage directions.',
          'When the call is done for you (the assistant said goodbye, or you got what you wanted and said goodbye), answer exactly [HANG UP].',
        ].join('\n'),
      },
      { role: 'user', content: `The call so far:\n${said}\n\nYour next line:` },
    ],
    { temperature: 0.7 },
  )
  const text = reply.trim().replace(/^(You|Caller):\s*/i, '')
  return !text || /\[HANG UP\]/i.test(text) ? null : text
}
