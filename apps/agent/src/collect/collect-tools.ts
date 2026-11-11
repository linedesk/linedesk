// The assistant's collection tools: each runs one collection step (collect-task.ts) and returns
// the confirmed value, or what to do when there is none, in words the assistant can act on.
import { llm } from '@livekit/agents'
import type { Room } from '@livekit/rtc-node'
import { z } from 'zod'
import type { CallLog } from '../call-log.ts'
import { CollectTask, type CollectTaskOptions } from './collect-task.ts'
import { describeOutcome, outcomeEvent } from './collection.ts'
import { addressCollector, dateCollector, digitsCollector, emailCollector, nameCollector, phoneCollector } from './collectors.ts'

type AnyCollector = CollectTaskOptions['collector']

export type CollectContext = {
  log: CallLog
  /** The call's room, for keypad presses; the caller's identity once known. */
  room: Room | null
  callerIdentity: () => string | undefined
  /** Today in the business's time zone, YYYY-MM-DD. */
  today: () => string
  /** Which language the steps speak (collectLanguageRule in prompt.ts); default English only. */
  languageRule?: string
}

async function runStep(ctx: CollectContext, { ctx: run }: llm.ToolOptions, collector: AnyCollector, keypad: boolean) {
  const chatCtx = run.session.currentAgent.chatCtx.copy({ excludeFunctionCall: true, excludeInstructions: true })
  const room = keypad ? ctx.room : null
  const callerIdentity = ctx.callerIdentity()
  try {
    const task = new CollectTask({
      collector,
      chatCtx,
      ...(ctx.languageRule ? { languageRule: ctx.languageRule } : {}),
      ...(room ? { keypad: { room, ...(callerIdentity ? { callerIdentity } : {}) } } : {}),
    })
    const outcome = await task.run()
    ctx.log.record('system', outcomeEvent(outcome))
    if (collector.kind === 'name' && outcome.status === 'confirmed') ctx.log.confirmedName = outcome.value
    nudgeIfQuiet(run.session)
    return describeOutcome(outcome) + saidMeanwhile(task.chatCtx.items.slice(chatCtx.items.length))
  } catch (e) {
    console.warn(`collection step ${collector.kind} ended early: ${e instanceof Error ? e.message : String(e)}`)
    return `Getting the ${collector.label} did not work. Note what you have and tell the caller someone will call them back.`
  }
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
    session.generateReply({ instructions: 'Go on with the call: answer what the caller asked or wanted, or ask for what you still need.' })
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
      execute: async (_args, opts) => runStep(ctx, opts, nameCollector, false),
    }),
    get_phone_number: llm.tool({
      description: 'Get a phone number from the caller (spoken or typed on the keypad) and confirm it.',
      parameters: z.object({ what: z.string().nullish().describe('What the number is for, e.g. "callback number". Default: callback number.') }),
      execute: async ({ what }, opts) => runStep(ctx, opts, phoneCollector(what?.trim() || 'callback number'), true),
    }),
    get_address: llm.tool({
      description: 'Get the street address of a visit (US) and confirm it.',
      execute: async (_args, opts) => runStep(ctx, opts, addressCollector, false),
    }),
    get_email: llm.tool({
      description: "Get the caller's email address, spelled, and confirm it.",
      execute: async (_args, opts) => runStep(ctx, opts, emailCollector, false),
    }),
    get_date: llm.tool({
      description: 'Get a date from the caller (for example a preferred day or a date of birth) and confirm it.',
      parameters: z.object({ what: z.string().describe('What the date is, e.g. "preferred day".') }),
      execute: async ({ what }, opts) => runStep(ctx, opts, dateCollector({ what, today: ctx.today() }), false),
    }),
    get_digits: llm.tool({
      description: 'Get a number made of digits (account, policy, ZIP code) by keypad or speech, and confirm it.',
      parameters: z.object({
        what: z.string().describe('What it is, e.g. "account number".'),
        min_digits: z.number().int().min(1).max(20).describe('Fewest digits it can have.'),
        max_digits: z.number().int().min(1).max(20).describe('Most digits it can have.'),
      }),
      execute: async ({ what, min_digits, max_digits }, opts) =>
        runStep(ctx, opts, digitsCollector({ what, minDigits: Math.min(min_digits, max_digits), maxDigits: Math.max(min_digits, max_digits), keypad: true }), true),
    }),
  }
}
