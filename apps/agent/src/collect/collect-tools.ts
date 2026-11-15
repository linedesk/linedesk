// The assistant's collection tools: each runs one collection step (collect-task.ts) and returns
// the confirmed value, or what to do when there is none, in words the assistant can act on.
import { llm } from '@livekit/agents'
import { z } from 'zod'
import type { CallLog } from '../call-log.ts'
import { CollectTask, type CollectTaskOptions } from './collect-task.ts'
import { describeOutcome, noCallerIdRule, outcomeEvent } from './collection.ts'
import { addressCollector, dateCollector, digitsCollector, emailCollector, nameCollector, phoneCollector, todayFact } from './collectors.ts'
import { phoneStepRefusal } from '../callback-number.ts'

type AnyCollector = CollectTaskOptions['collector']

export type CollectContext = {
  log: CallLog
  /** Today in the business's time zone, YYYY-MM-DD. */
  today: () => string
  /**
   * Which language a step speaks (collectLanguageRule in prompt.ts), asked when it starts: the caller may have switched
   * language by then. Missing or undefined: English only.
   */
  languageRule?: () => string | undefined
  /** The step running now (set by runStep): told when the caller switches language during it (languageChanged). */
  step?: CollectTask | null
  /** The caller's number from caller ID (callerIdOf); null or missing: unknown. Then it is the callback number. */
  callerId?: string | null
  /** A test call from the app (CallerContext.testCall): no caller ID by design, so no number to call back on. */
  testCall?: boolean
  /** What a step may answer a short question from (stepFacts); missing: only the value. */
  facts?: () => string
  /** The workspace's country: phone numbers are read as written there (CallSession.country); missing: US. */
  country?: string
}

/**
 * What a step may answer a caller's short question from, without handing back: the next two weeks with weekday and
 * date, and the business hours and address when known. Anything else goes back to the assistant (hand_back).
 */
export function stepFacts({ today, hours, address }: { today: string; hours?: string | null; address?: string | null }): string {
  return [todayFact(today), hours && `Business hours: ${hours}`, address?.trim() && `Business address: ${address.trim()}`].filter(Boolean).join('\n')
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
    const languageRule = ctx.languageRule?.()
    const task = new CollectTask({
      collector,
      chatCtx,
      ...(languageRule ? { languageRule } : {}),
      ...(ctx.facts ? { facts: ctx.facts() } : {}),
    })
    // While a step runs: if the call ends now, the call log still files a call back (mergeToolResults).
    ctx.log.collecting = collector.label
    ctx.step = task
    const outcome = await task.run().finally(() => {
      ctx.log.collecting = null
      if (ctx.step === task) ctx.step = null
    })
    ctx.log.record('system', outcomeEvent(outcome))
    if (collector.kind === 'name' && outcome.status === 'confirmed') ctx.log.confirmedName = outcome.value
    if (collector.kind === 'phone_number' && outcome.status === 'confirmed') ctx.log.confirmedNumbers.push(outcome.value)
    // What the summary writes the team's next step from (there is no tool to save a message during the call).
    if (outcome.status === 'confirmed') ctx.log.details.push({ label: outcome.label, value: outcome.value, confirmed: true })
    if (outcome.status === 'incomplete' && outcome.partial) ctx.log.details.push({ label: outcome.label, value: outcome.partial, confirmed: false })
    nudgeIfQuiet(run.session)
    return describeOutcome(outcome, { callerId: ctx.callerId ?? null, testCall: ctx.testCall === true }) + saidMeanwhile(task.chatCtx.items.slice(chatCtx.items.length))
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

/** The phone number step; without caller ID it knows that "the number I'm calling from" is not known (noCallerIdRule). */
export function phoneStep(ctx: Pick<CollectContext, 'callerId' | 'testCall' | 'country'>, label: string): AnyCollector {
  const collector = phoneCollector(label, ctx.country)
  if (ctx.callerId) return collector
  return { ...collector, instructions: `${collector.instructions}\n${noCallerIdRule(ctx.testCall === true)}` }
}

export function collectTools(ctx: CollectContext) {
  return {
    get_name: llm.tool({
      description: "Get the caller's first and last name, with the last name spelled, and confirm it.",
      execute: async (_args, opts) => runStep(ctx, opts, nameCollector),
    }),
    get_phone_number: llm.tool({
      description: ctx.callerId
        ? "Get a phone number from the caller and confirm it. The caller's own number is known from caller ID, and the team has it as the callback number: use this for a callback number only when the caller said they want to be called back on a different number."
        : 'Get a phone number from the caller and confirm it.',
      parameters: z.object({
        what: z.string().nullish().describe('What the number is for, in English, e.g. "callback number". Default: callback number.'),
        reason: z
          .string()
          .nullish()
          .describe('Why the caller gives a number other than the one they are calling from, in their words, e.g. "wants a call back on their work phone". Needed for a callback number when caller ID is known.'),
      }),
      execute: async ({ what, reason }, opts) => {
        const label = what?.trim() || 'callback number'
        const refusal = phoneStepRefusal(ctx.callerId ?? null, label, reason)
        if (refusal) return refusal
        // Only with caller ID is a callback number "another" one, and the reason worth a line for the team.
        if (ctx.callerId && reason?.trim()) ctx.log.record('system', `Asked for another ${label}: ${reason.trim()}`)
        return runStep(ctx, opts, phoneStep(ctx, label))
      },
    }),
    get_address: llm.tool({
      description: 'Get the street address of a visit (US) and confirm it.',
      execute: async (_args, opts) => runStep(ctx, opts, addressCollector),
    }),
    get_email: llm.tool({
      description: "Get the caller's email address, spelled, and confirm it: only when the appointment type asks for one, or the caller wants a confirmation by email.",
      execute: async (_args, opts) => runStep(ctx, opts, emailCollector),
    }),
    get_date: llm.tool({
      description: 'Get a date from the caller (for example a preferred day or a date of birth) and confirm it.',
      parameters: z.object({ what: z.string().describe('What the date is for, in English, e.g. "preferred day" or "callback day" (not the day itself).') }),
      execute: async ({ what }, opts) => runStep(ctx, opts, dateCollector({ what, today: ctx.today() })),
    }),
    get_digits: llm.tool({
      description: 'Get a number made of digits (an account number, a ZIP code) and confirm it.',
      parameters: z.object({
        what: z.string().describe('What it is, in English, e.g. "account number".'),
        min_digits: z.number().int().min(1).max(20).describe('Fewest digits it can have.'),
        max_digits: z.number().int().min(1).max(20).describe('Most digits it can have.'),
      }),
      execute: async ({ what, min_digits, max_digits }, opts) =>
        runStep(ctx, opts, digitsCollector({ what, minDigits: Math.min(min_digits, max_digits), maxDigits: Math.max(min_digits, max_digits) })),
    }),
  }
}
