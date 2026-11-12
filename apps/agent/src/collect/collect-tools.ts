// The assistant's collection tools: each runs one collection step (collect-task.ts) and returns
// the confirmed value, or what to do when there is none, in words the assistant can act on.
import { llm } from '@livekit/agents'
import { z } from 'zod'
import type { CallLog } from '../call-log.ts'
import { CollectTask, type CollectTaskOptions } from './collect-task.ts'
import { type CollectOutcome, describeOutcome, outcomeEvent } from './collection.ts'
import { addressCollector, dateCollector, digitsCollector, emailCollector, nameCollector, phoneCollector } from './collectors.ts'

type AnyCollector = CollectTaskOptions['collector']

export type CollectContext = {
  log: CallLog
  /** Today in the business's time zone, YYYY-MM-DD. */
  today: () => string
  /** Which language the steps speak (collectLanguageRule in prompt.ts); default English only. */
  languageRule?: string
  /**
   * Adds a detail to the message already saved on this call (call.takeMessage); false when there is no message yet
   * or it could not be saved. A number confirmed after the message would otherwise be lost.
   */
  addToMessage?: (detail: string) => Promise<boolean>
}

/**
 * Tools of one response run side by side: the model sometimes asks for the caller's name and puts them through in the
 * same breath. A step waits this long, so a transfer_call of the same response has put the caller on hold.
 */
export const SAME_RESPONSE_MS = 300
/** What a step returns when the caller is on hold for a transfer: it asks nothing. */
export const ON_HOLD_REPLY = 'The caller is on hold while you put them through to a person: do not ask them anything now.'

async function runStep(ctx: CollectContext, { ctx: run }: llm.ToolOptions, collector: AnyCollector) {
  await new Promise(resolve => setTimeout(resolve, SAME_RESPONSE_MS))
  if (ctx.log.onHold) return ON_HOLD_REPLY
  const chatCtx = run.session.currentAgent.chatCtx.copy({ excludeFunctionCall: true, excludeInstructions: true })
  try {
    const task = new CollectTask({
      collector,
      chatCtx,
      ...(ctx.languageRule ? { languageRule: ctx.languageRule } : {}),
    })
    const outcome = await task.run()
    ctx.log.record('system', outcomeEvent(outcome))
    if (collector.kind === 'name' && outcome.status === 'confirmed') ctx.log.confirmedName = outcome.value
    nudgeIfQuiet(run.session)
    return describeOutcome(outcome) + (await addedToMessage(ctx, collector, outcome)) + saidMeanwhile(task.chatCtx.items.slice(chatCtx.items.length))
  } catch (e) {
    console.warn(`collection step ${collector.kind} ended early: ${e instanceof Error ? e.message : String(e)}`)
    return `Getting the ${collector.label} did not work. Note what you have and tell the caller someone will call them back.`
  }
}

/** A phone number confirmed after the message was saved goes onto the call too; what the assistant is told about it. */
export async function addedToMessage(ctx: CollectContext, collector: AnyCollector, outcome: CollectOutcome): Promise<string> {
  if (collector.kind !== 'phone_number' || outcome.status !== 'confirmed' || !ctx.addToMessage) return ''
  const what = outcome.label.charAt(0).toUpperCase() + outcome.label.slice(1)
  const added = await ctx.addToMessage(`${what}: ${outcome.value} (confirmed with the caller).`)
  return added ? ' It is added to the message you saved already: do not use take_message for it.' : ''
}

/** How long after a step the assistant may stay quiet before it is asked to go on. */
export const QUIET_AFTER_STEP_MS = 3000

type Quiet = { agentState: string; userState: string; generateReply(options: { instructions: string }): unknown }

/**
 * After a step hands back, the model's reply to the step's result sometimes comes back empty: the caller then hears
 * nothing until the silence reminder. If the assistant is still only listening after QUIET_AFTER_STEP_MS and the
 * caller is not talking, it is asked once to go on.
 */
export function nudgeIfQuiet(session: Quiet, waitMs = QUIET_AFTER_STEP_MS) {
  setTimeout(() => {
    if (session.agentState !== 'listening' || session.userState === 'speaking') return
    // The call may have ended meanwhile: a closing session throws, and a throw in a timer would end the whole job
    // before the call is finished (no summary, the call left live).
    try {
      session.generateReply({ instructions: 'Go on with the call: answer what the caller asked or wanted, or ask for what you still need.' })
    } catch {}
  }, waitMs).unref?.()
}

/** How many of the caller's lines from a step are passed back: the last ones hold what is still open. */
const MEANWHILE_LINES = 4

/**
 * What the caller said during a step, for the assistant: the step only collects one value and puts other
 * questions off ("I'll come back to that"), so the assistant answers them once the step is done.
 */
export function saidMeanwhile(items: readonly llm.ChatItem[]): string {
  const lines = items
    .flatMap(item => (item.type === 'message' && item.role === 'user' && item.textContent ? [item.textContent.trim()] : []))
    .filter(Boolean)
    .slice(-MEANWHILE_LINES)
  if (!lines.length) return ''
  return ` While you got it the caller said: ${lines.map(line => `"${line}"`).join(' ')} If they asked or wanted anything else, answer that now before you go on.`
}

export function collectTools(ctx: CollectContext) {
  return {
    get_name: llm.tool({
      description: "Get the caller's first and last name, with the last name spelled, and confirm it.",
      execute: async (_args, opts) => runStep(ctx, opts, nameCollector),
    }),
    get_phone_number: llm.tool({
      description: 'Get a phone number from the caller and confirm it.',
      parameters: z.object({ what: z.string().nullish().describe('What the number is for, e.g. "callback number". Default: callback number.') }),
      execute: async ({ what }, opts) => runStep(ctx, opts, phoneCollector(what?.trim() || 'callback number')),
    }),
    get_address: llm.tool({
      description: 'Get the street address of a visit (US) and confirm it.',
      execute: async (_args, opts) => runStep(ctx, opts, addressCollector),
    }),
    get_email: llm.tool({
      description: "Get the caller's email address, spelled, and confirm it.",
      execute: async (_args, opts) => runStep(ctx, opts, emailCollector),
    }),
    get_date: llm.tool({
      description: 'Get a date from the caller (for example a preferred day or a date of birth) and confirm it.',
      parameters: z.object({ what: z.string().describe('What the date is, e.g. "preferred day".') }),
      execute: async ({ what }, opts) => runStep(ctx, opts, dateCollector({ what, today: ctx.today() })),
    }),
    get_digits: llm.tool({
      description: 'Get a number made of digits (an account number, a ZIP code) and confirm it.',
      parameters: z.object({
        what: z.string().describe('What it is, e.g. "account number".'),
        min_digits: z.number().int().min(1).max(20).describe('Fewest digits it can have.'),
        max_digits: z.number().int().min(1).max(20).describe('Most digits it can have.'),
      }),
      execute: async ({ what, min_digits, max_digits }, opts) =>
        runStep(ctx, opts, digitsCollector({ what, minDigits: Math.min(min_digits, max_digits), maxDigits: Math.max(min_digits, max_digits) })),
    }),
  }
}
