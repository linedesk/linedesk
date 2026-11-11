// One collection step's state, without LiveKit: what was heard, whether it was read back and
// confirmed, how many tries are left. The task (collect-task.ts) drives it from tool calls and
// keypad presses; the tests drive it from simulated transcripts.
import type { Collector } from './collectors.ts'

/** Tries (a value that does not check out, or one the caller says is wrong) before the step gives up. */
export const MAX_ATTEMPTS = 3

export type CollectOutcome =
  | { status: 'confirmed'; label: string; value: string; via: 'speech' | 'keypad' }
  /** Out of tries: `partial` is the best unconfirmed guess, if any. */
  | { status: 'incomplete'; label: string; partial: string | null }
  | { status: 'declined'; label: string; reason: string }

/** What a tool call returns to the collecting model, and whether the step is over. */
export type StepReply = { say: string; outcome?: CollectOutcome }

export class Collection<Args extends Record<string, unknown>, T> {
  private pending: { value: T; via: 'speech' | 'keypad' } | null = null
  private lastHeard: string | null = null
  private failures = 0
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

  /** A new hypothesis about the value (from speech, or typed on the keypad). */
  record(args: Args, via: 'speech' | 'keypad' = 'speech'): StepReply {
    if (this.outcome) return { say: 'This step is over.' }
    const parsed = this.collector.parse(args)
    this.lastHeard = describeArgs(args)
    if (!parsed.ok) return this.fail(parsed.problem)
    this.pending = { value: parsed.value, via }
    this.lastHeard = this.collector.display(parsed.value)
    return {
      say: `Heard ${this.collector.label}: ${this.collector.display(parsed.value)}. Read it back to the caller exactly like this: "${this.collector.readBack(parsed.value)}", and ask if it is right. Do not call confirm_${this.collector.kind} until the caller said yes.`,
    }
  }

  /** The caller said the read-back is right. */
  confirm(): StepReply {
    if (this.outcome) return { say: 'This step is over.' }
    if (!this.pending) return { say: `Nothing to confirm yet: record the ${this.collector.label} first, then read it back.` }
    const { value, via } = this.pending
    return this.finish({ status: 'confirmed', label: this.collector.label, value: this.collector.display(value), via })
  }

  /** The caller said the read-back is wrong. */
  reject(): StepReply {
    if (this.outcome) return { say: 'This step is over.' }
    this.pending = null
    return this.fail(`The caller says that is not right. Ask for the ${this.collector.label} again${this.attemptsLeft <= 2 ? ', one part at a time' : ''}.`)
  }

  /** The caller does not want to give it. */
  decline(reason: string): StepReply {
    return this.finish({ status: 'declined', label: this.collector.label, reason })
  }

  /** The keypad or the caller gave up without a usable value. */
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

/** What the main assistant is told when the step is over. */
export function describeOutcome(outcome: CollectOutcome): string {
  switch (outcome.status) {
    case 'confirmed':
      return `The caller confirmed the ${outcome.label}: ${outcome.value}. Use exactly this (in take_message or the booking); do not ask for it again.`
    case 'incomplete':
      return `Could not get a confirmed ${outcome.label}${outcome.partial ? `; best guess (not confirmed): ${outcome.partial}` : ''}. Tell the caller you will note what you have and someone will call them back. Put it in take_message${outcome.partial ? ' marked as unconfirmed' : ''}, and do not ask for it again.`
    case 'declined':
      return `The caller did not want to give the ${outcome.label} (${outcome.reason}). Go on without it.`
  }
}

/** One line for the call's transcript (the team sees how the value was taken). */
export function outcomeEvent(outcome: CollectOutcome): string {
  const what = outcome.label.charAt(0).toUpperCase() + outcome.label.slice(1)
  if (outcome.status === 'confirmed') return `${what} confirmed${outcome.via === 'keypad' ? ' · typed on the keypad' : ''}`
  if (outcome.status === 'declined') return `${what} not given`
  return `${what} not confirmed`
}

// ---------- keypad ----------

export type KeypadResult = { digits: string; ended: 'pound' | 'timeout' | 'full' }
type Timers = { set: (fn: () => void, ms: number) => unknown; clear: (handle: unknown) => void }
const realTimers: Timers = { set: (fn, ms) => setTimeout(fn, ms), clear: h => clearTimeout(h as ReturnType<typeof setTimeout>) }

/** Seconds to wait for the next key before taking what was typed. */
export const KEYPAD_DIGIT_TIMEOUT_MS = 4000

/**
 * Keys typed on the phone: digits until # (or `maxDigits`, or a pause), `*` starts over. The first
 * key starts it; the caller may also just speak, which the task handles.
 */
export class KeypadInput {
  private digits = ''
  private timer: unknown = null
  private done = false
  private readonly maxDigits: number
  private readonly onDone: (result: KeypadResult) => void
  private readonly digitTimeoutMs: number
  private readonly timers: Timers

  constructor(maxDigits: number, onDone: (result: KeypadResult) => void, digitTimeoutMs = KEYPAD_DIGIT_TIMEOUT_MS, timers: Timers = realTimers) {
    this.maxDigits = maxDigits
    this.onDone = onDone
    this.digitTimeoutMs = digitTimeoutMs
    this.timers = timers
  }

  get typing() {
    return this.digits.length > 0 && !this.done
  }

  press(key: string) {
    if (this.done) return
    this.stopTimer()
    if (key === '#') return this.end(this.digits ? 'pound' : null)
    if (key === '*') {
      this.digits = ''
      return
    }
    if (!/^\d$/.test(key)) return
    this.digits += key
    if (this.digits.length >= this.maxDigits) return this.end('full')
    this.timer = this.timers.set(() => this.end('timeout'), this.digitTimeoutMs)
  }

  /** Ready for the next try. */
  reset() {
    this.stopTimer()
    this.digits = ''
    this.done = false
  }

  stop() {
    this.stopTimer()
    this.done = true
  }

  private end(ended: KeypadResult['ended'] | null) {
    if (!ended) return
    this.stopTimer()
    this.done = true
    this.onDone({ digits: this.digits, ended })
  }

  private stopTimer() {
    if (this.timer !== null) this.timers.clear(this.timer)
    this.timer = null
  }
}

/** DTMF codes as LiveKit sends them: 0–9, 10 = *, 11 = #. */
export const dtmfCode = (key: string) => (key === '*' ? 10 : key === '#' ? 11 : Number(key))
