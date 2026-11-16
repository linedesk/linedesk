// A collection step on a live call: a LiveKit AgentTask that takes over the conversation until the
// value is confirmed, the caller declines, or the tries run out, then hands back to the assistant.
import { llm, voice } from '@livekit/agents'
import { z } from 'zod'
import { Collection, type CollectOutcome, type StepReply } from './collection.ts'
import type { Collector } from './collectors.ts'

/** Ported from LiveKit's Python tasks: the rules every step shares. */
const STEP_RULES = [
  'You are only a single step in a phone call, responsible solely for collecting one piece of information. One or two short sentences at a time, no lists or markdown.',
  'Call the record tool as soon as you form a new hypothesis about the value, before asking anything else. Do not invent values: stick strictly to what the caller said.',
  'After the record tool, read the value back exactly as it tells you and ask whether it is right. If the caller says yes, call the confirm tool; if they say no or correct it, call the wrong tool (or record the correction).',
  'If the caller says they do not want to give it, or cannot, call decline with their words. Ask your question first: decline and wrong only count once the caller answered it. Always call tools explicitly; never pretend to.',
  'If the caller asks a short question you can answer from the facts below (today\'s date, the opening hours), answer it in one sentence, then ask for the value again.',
  'Any other question or request: call hand_back with it right away, so the assistant answers it. Never put the caller off ("I will come back to that") twice in a row.',
  'You know nothing else about the caller, their appointments or their account: never confirm or deny anything they ask about (not even "yes, I see that"); call hand_back with it.',
].join('\n')

/** A line in which the step put the caller's question off. */
export const putsOff = (text: string) => /\b(come back to (that|it|this)|get (back )?to (that|it|this) in a (moment|minute|second)|in a moment)\b/i.test(text)

/**
 * Whether the caller's new line goes back to the assistant: the step's last line put a question off and the caller
 * asks again (a question mark, or a question word at the start), so a second "I'll come back to that" never comes.
 */
export function askedAgainAfterPutOff(lastStepLine: string | undefined, callerLine: string): boolean {
  if (!lastStepLine || !putsOff(lastStepLine)) return false
  return /\?\s*$/.test(callerLine.trim()) || /^(what|which|when|where|who|why|how|can|could|do|does|is|are|will|would)\b/i.test(callerLine.trim())
}

// biome-ignore lint/suspicious/noExplicitAny: a step holds one collector of any argument and value type
type AnyCollector = Collector<any, any>

/** Which language a step speaks, unless the call allows others (collectLanguageRule in prompt.ts). */
export const COLLECT_ENGLISH_ONLY = 'Speak English.'

export type CollectTaskOptions = {
  collector: AnyCollector
  /** Which language to speak; default COLLECT_ENGLISH_ONLY. */
  languageRule?: string
  /** The call so far, so a name or number already given is not asked again. */
  chatCtx?: llm.ChatContext
  /** What the step may answer a short question from (stepFacts): the next days with their dates, the business hours. */
  facts?: string
}

/** A step's instructions: the shared rules, the language rule, the collector's own and the facts. */
const stepInstructions = (languageRule: string, collector: AnyCollector, facts?: string) =>
  `${STEP_RULES}\n${languageRule}\n\n${collector.instructions}${facts ? `\n\nFacts you may answer from:\n${facts}` : ''}`

export class CollectTask extends voice.AgentTask<CollectOutcome> {
  private readonly collection: Collection<Record<string, unknown>, unknown>
  private readonly facts: string | undefined

  constructor({ collector, chatCtx, facts, languageRule = COLLECT_ENGLISH_ONLY }: CollectTaskOptions) {
    const collection = new Collection(collector)
    const kind = collector.kind
    // The tools finish the task; it exists once super() returned.
    const self: { task?: CollectTask } = {}
    const settle = (reply: StepReply) => {
      if (reply.outcome && self.task && !self.task.done) self.task.complete(reply.outcome)
      return reply.outcome ? undefined : reply.say
    }
    super({
      instructions: stepInstructions(languageRule, collector, facts),
      ...(chatCtx ? { chatCtx } : {}),
      tools: {
        [`record_${kind}`]: llm.tool({
          description: `Record the ${collector.label} the caller just said (or a correction).`,
          parameters: collector.parameters as z.ZodObject<z.ZodRawShape>,
          execute: async args => settle(collection.record(args as Record<string, unknown>)),
        }),
        [`confirm_${kind}`]: llm.tool({
          description: `Call only after the caller said the ${collector.label} you read back is right.`,
          execute: async () => settle(collection.confirm()),
        }),
        [`wrong_${kind}`]: llm.tool({
          description: `The caller says the ${collector.label} you read back is wrong and did not say the right one yet.`,
          execute: async () => settle(collection.reject()),
        }),
        hand_back: llm.tool({
          description: 'The caller asked or wants something other than the value, which the facts here do not answer: the assistant takes it over.',
          parameters: z.object({ question: z.string().describe("The caller's question or request, in their words.") }),
          execute: async ({ question }) => settle(collection.handBack(question)),
        }),
        decline: llm.tool({
          description: `The caller does not want to give the ${collector.label}, or cannot.`,
          parameters: z.object({ reason: z.string().describe("The caller's words.") }),
          execute: async ({ reason }) => settle(collection.decline(reason)),
        }),
      },
    })
    self.task = this
    this.collection = collection
    this.facts = facts
  }

  /** The caller switched language during the step: it speaks the new one from its next line (collectLanguageRule). */
  async languageChanged(languageRule: string | undefined) {
    if (this.done) return
    await this.updateInstructions(stepInstructions(languageRule ?? COLLECT_ENGLISH_ONLY, this.collection.collector, this.facts))
  }

  /**
   * Every caller turn in the step counts (decline and wrong_* need one). The caller asks again after the step put them
   * off: the question goes to the assistant instead of a second put-off.
   */
  override async onUserTurnCompleted(chatCtx: llm.ChatContext, newMessage: llm.ChatMessage) {
    if (!this.done) this.collection.heardCaller()
    const lastStepLine = chatCtx.items
      .filter((item): item is llm.ChatMessage => item.type === 'message' && item.role === 'assistant')
      .at(-1)?.textContent
    const callerLine = newMessage.textContent ?? ''
    if (this.done || !askedAgainAfterPutOff(lastStepLine, callerLine)) return
    this.complete(this.collection.handBack(callerLine).outcome!)
    throw new voice.StopResponse()
  }

  override async onEnter() {
    // A realtime model reports no caller turns (onUserTurnCompleted): the step's question having played stands in.
    if (this.session.llm instanceof llm.RealtimeModel) this.collection.uncountedTurns()
    const ask = this.session.generateReply({
      instructions: `${this.collection.collector.ask} If the caller already gave it earlier in this call, record it with the record tool and read it back instead of asking again.`,
    })
    const asked = () => this.collection.askedQuestion()
    if (ask.done()) asked()
    else ask.addDoneCallback(asked)
  }
}
