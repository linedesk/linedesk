// One collection step's state, without LiveKit: what was heard, whether it was read back and
// confirmed, how many tries are left. The task (collect-task.ts) drives it from tool calls; the
// tests drive it from simulated transcripts.
import type { Collector } from './collectors.ts'

/** Tries (a value that does not check out, or one the caller says is wrong) before the step gives up. */
export const MAX_ATTEMPTS = 3

export type CollectOutcome =
  | { status: 'confirmed'; label: string; value: string }
  /** Out of tries: `partial` is the best unconfirmed guess, if any. */
  | { status: 'incomplete'; label: string; partial: string | null }
  | { status: 'declined'; label: string; reason: string }
  /** The caller asked something the step cannot answer: the assistant answers it and gets the value again if needed. */
  | { status: 'question'; label: string; question: string; partial: string | null }

/** What a tool call returns to the collecting model, and whether the step is over. */
export type StepReply = { say: string; outcome?: CollectOutcome }

/** What decline and wrong_* say before the caller said anything in the step: the step's question comes first. */
export const ASK_FIRST = 'Ask the caller first.'

export class Collection<Args extends Record<string, unknown>, T> {
  private pending: { value: T } | null = null
  private lastHeard: string | null = null
  private failures = 0
  /** The caller's turns since the step asked its question. */
  private callerTurns = 0
  /**
   * Whether caller turns are counted (heardCaller). A realtime model reports none: LiveKit calls onUserTurnCompleted
   * only with its own turn detection, and a realtime transcript arrives after the model has answered. There the step
   * counts as heard once its question has played (askedQuestion).
   */
  private turnsCounted = true
  private questionPlayed = false
  outcome: CollectOutcome | null = null
  readonly collector: Collector<Args, T>
  readonly maxAttempts: number

  constructor(collector: Collector<Args, T>, maxAttempts = MAX_ATTEMPTS) {
    this.collector = collector
    this.maxAttempts = maxAttempts
  }

  get attemptsLeft() {
    return this.maxAttempts - this.failures
  }

  /** The caller finished a turn during the step (after its question). */
  heardCaller() {
    this.callerTurns++
  }

  /** Caller turns are not reported on this call (a realtime model): askedQuestion stands in for them. */
  uncountedTurns() {
    this.turnsCounted = false
  }

  /** The step's question has played: the caller has had the chance to answer. */
  askedQuestion() {
    this.questionPlayed = true
  }

  /** Whether the caller may have answered the step's question: a turn heard, or on realtime the question played. */
  private get callerHadTurn() {
    return this.turnsCounted ? this.callerTurns > 0 : this.questionPlayed
  }

  /** A new hypothesis about the value, from what the caller said. */
  record(args: Args): StepReply {
    if (this.outcome) return { say: 'This step is over.' }
    const parsed = this.collector.parse(args)
    this.lastHeard = describeArgs(args)
    // Which of two days is a question for the caller, not a wrong value: it does not use up a try.
    if (!parsed.ok) return parsed.ask ? { say: parsed.problem } : this.fail(parsed.problem)
    this.pending = { value: parsed.value }
    this.lastHeard = this.collector.display(parsed.value)
    return {
      say: `Heard ${this.collector.label}: ${this.collector.display(parsed.value)}. Read it back to the caller exactly like this: "${this.collector.readBack(parsed.value)}", and ask if it is right. Do not call confirm_${this.collector.kind} until the caller said yes.`,
    }
  }

  /** The caller said the read-back is right. */
  confirm(): StepReply {
    if (this.outcome) return { say: 'This step is over.' }
    if (!this.pending) return { say: `Nothing to confirm yet: record the ${this.collector.label} first, then read it back.` }
    const { value } = this.pending
    return this.finish({ status: 'confirmed', label: this.collector.label, value: this.collector.display(value) })
  }

  /** The caller said the read-back is wrong. Not before the caller said anything in the step: that is no try. */
  reject(): StepReply {
    if (this.outcome) return { say: 'This step is over.' }
    if (!this.callerHadTurn) return { say: ASK_FIRST }
    this.pending = null
    return this.fail(`The caller says that is not right. Ask for the ${this.collector.label} again${this.attemptsLeft <= 2 ? ', one part at a time' : ''}.`)
  }

  /**
   * The caller does not want to give it. Only once they answered the step's question: words from earlier in the call
   * (filler, "yes") are no refusal.
   */
  decline(reason: string): StepReply {
    if (this.outcome) return { say: 'This step is over.' }
    if (!this.callerHadTurn) return { say: ASK_FIRST }
    return this.finish({ status: 'declined', label: this.collector.label, reason })
  }

  /**
   * The caller asked something only the assistant can answer: the step hands back with the question. Not before the
   * caller said anything in the step: a realtime model handed back at once on words from earlier in the call, so the
   * assistant started the step again and again (callback-message, 2026-11-15).
   */
  handBack(question: string): StepReply {
    if (this.outcome) return { say: 'This step is over.' }
    if (!this.callerHadTurn) return { say: ASK_FIRST }
    return this.finish({ status: 'question', label: this.collector.label, question, partial: this.pending ? this.collector.display(this.pending.value) : this.lastHeard })
  }

  /** The caller gave up without a usable value. */
  giveUp(): StepReply {
    return this.finish({ status: 'incomplete', label: this.collector.label, partial: this.lastHeard })
  }

  private fail(problem: string): StepReply {
    this.failures++
    if (this.failures >= this.maxAttempts) return this.giveUp()
    return { say: problem }
  }

  private finish(outcome: CollectOutcome): StepReply {
    this.outcome ??= outcome
    return { say: '', outcome: this.outcome }
  }
}

const describeArgs = (args: Record<string, unknown>) =>
  Object.values(args)
    .filter(v => typeof v === 'string' && v.trim())
    .join(', ') || null

/** Whether a step's label is a phone number the team calls back on (phoneCollector's default label, or one like it). */
const isCallbackNumber = (label: string) => /\b(phone|callback|call-back|number)\b/i.test(label) && !/account|zip|member|policy|order/i.test(label)

/**
 * What a phone number step adds to its instructions on a call without caller ID: callers say "the number I'm calling
 * from", which the step cannot see. On a test call from the app there is no such number at all, so the step ends
 * (LIN-277); on a phone call with a withheld number the caller is asked to say it.
 */
export function noCallerIdRule(testCall: boolean): string {
  return testCall
    ? `This is a test call from the app: there is no caller ID, so there is no number the caller is calling from. If the caller says to use the number they are calling from (or this number), do not ask again: call decline with the reason "${TEST_CALL_NO_NUMBER}".`
    : 'There is no caller ID on this call: you cannot see the number the caller is calling from. If they say to use that number, tell them you cannot see it, and ask them to say it.'
}

/** The decline reason of a number step on a test call when the caller means the number they are calling from. */
export const TEST_CALL_NO_NUMBER = 'test call, no caller ID'

/**
 * What the main assistant is told when the step is over. `callerId`: the caller's number from caller ID; without it
 * a declined callback number leaves the team no way to call back, so the assistant says so and asks once more. On a
 * test call from the app (`testCall`) there is no number to ask for: the assistant notes that and goes on.
 */
export function describeOutcome(outcome: CollectOutcome, { callerId, testCall = false }: { callerId?: string | null; testCall?: boolean } = {}): string {
  switch (outcome.status) {
    case 'confirmed':
      return `The caller confirmed the ${outcome.label}: ${outcome.value}. Use exactly this (in take_message or the booking); do not ask for it again.`
    case 'incomplete':
      return `Could not get a confirmed ${outcome.label}${outcome.partial ? `; best guess (not confirmed): ${outcome.partial}` : ''}. Tell the caller you will note what you have and someone will call them back. Put it in take_message${outcome.partial ? ' marked as unconfirmed' : ''}, and do not ask for it again.`
    case 'declined':
      if (!callerId && testCall && isCallbackNumber(outcome.label))
        return `This is a test call from the app, with no caller ID: there is no ${outcome.label} to get (${outcome.reason}). Do not ask for it again; put "${TEST_CALL_NO_NUMBER}" in take_message and go on.`
      if (!callerId && isCallbackNumber(outcome.label))
        return `The caller did not give the ${outcome.label} (${outcome.reason}). Tell the caller the team cannot call back without a number, and ask once more.`
      return `The caller did not want to give the ${outcome.label} (${outcome.reason}). Go on without it.`
    case 'question':
      return `While you were getting the ${outcome.label}, the caller asked: "${outcome.question}". Answer that now, in a sentence or two${outcome.partial ? ` (heard so far, not confirmed: ${outcome.partial})` : ''}. Then, if you still need the ${outcome.label}, get it again with the same tool.`
  }
}

/** One line for the call's transcript (the team sees how the value was taken). */
export function outcomeEvent(outcome: CollectOutcome): string {
  const what = outcome.label.charAt(0).toUpperCase() + outcome.label.slice(1)
  if (outcome.status === 'confirmed') return `${what} confirmed`
  if (outcome.status === 'declined') return `${what} not given`
  if (outcome.status === 'question') return `${what} paused for the caller's question`
  return `${what} not confirmed`
}
