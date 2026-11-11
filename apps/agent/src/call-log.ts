// What happened in one call, and how it ends: every call that was started gets finished.
import type { LeadInput } from '@linedesk/actions'
import type { CallSession, Speaker } from './call-session.ts'
import { withRetry, type RetryOptions } from './retry.ts'
import { mergeToolResults, summarizeCall, unsummarizedResult, type CompleteJson, type TranscriptLine } from './summary.ts'

const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** Transcript lines and tool results of one call; writes each line through the API as it happens. */
export class CallLog {
  readonly lines: TranscriptLine[] = []
  readonly messages: string[] = []
  urgent = false
  /** What the assistant booked on this call ("Repair visit, Tuesday, November 17 at 9:00 AM"). */
  readonly bookings: string[] = []
  /** The caller was put through to the on-call person (a warm transfer that connected). */
  transferred = false
  /** Lead details the caller gave to a tool (take_message, book_appointment): they win over the summary. */
  lead: LeadInput = {}
  private pending: Promise<unknown>[] = []

  private call: CallSession

  constructor(call: CallSession) {
    this.call = call
  }

  record(speaker: Speaker, text: string, tool?: string) {
    this.lines.push({ speaker, text })
    const write = this.call.append(speaker, text, tool ? { tool, label: text } : undefined)
      .catch(e => console.error(`could not write transcript segment: ${message(e)}`))
    this.pending.push(write)
  }

  flush = () => Promise.all(this.pending)
}

/**
 * Summarizes and finishes the call. A failed or slow summary still finishes the call, without one;
 * `call.finish` is retried with backoff. Throws only if the API cannot be reached at all, in which
 * case the API's sweep completes the call later.
 */
export async function finishCall(call: CallSession, log: CallLog, complete: CompleteJson, retry?: RetryOptions) {
  await log.flush()
  const summary = await summarizeWithRetry(call, log, complete, retry).catch(e => {
    console.error(`could not summarize call ${call.callId}, finishing it without a summary: ${message(e)}`)
    return unsummarizedResult(log.lines, log.messages)
  })
  await withRetry(() => call.finish(mergeToolResults(summary, log)), retry)
}

/** A timed-out request is not repeated: a second one would not fit into the hang-up budget. */
const isTimeout = (e: unknown) => e instanceof Error && (e.name === 'TimeoutError' || /timeout|timed out/i.test(e.message))
export const SUMMARY_RETRY_DELAY_MS = 2000

/** Summarizes; a failed request (a rate limit, a bad answer) is tried once more after a short pause. */
async function summarizeWithRetry(call: CallSession, log: CallLog, complete: CompleteJson, retry?: RetryOptions) {
  try {
    return await summarizeCall(log.lines, complete, log.messages, call.customFields)
  } catch (e) {
    if (isTimeout(e)) throw e
    console.warn(`summary of call ${call.callId} failed, trying once more: ${message(e)}`)
    const pause = retry?.wait ?? ((ms: number) => new Promise(resolve => setTimeout(resolve, ms)))
    await pause(SUMMARY_RETRY_DELAY_MS)
    return summarizeCall(log.lines, complete, log.messages, call.customFields)
  }
}

/**
 * Everything after the caller is gone has to fit into the worker's shutdown window (60 s by default):
 *   stop the recording                      at once, so the file has no trailing audio
 *   summary                                 at most 15 s (the LLM request's timeout); a failure that is not a
 *                                           timeout is tried once more after 2 s; then finish without one
 *   call.finish                             4 attempts of at most 5 s each, 3.5 s of backoff in between
 *   wait for the recording file, report it  at most RECORDING_WAIT_MS, then call.setRecording
 * The whole sequence is cut off after HANGUP_BUDGET_MS. What did not fit is repaired by the API:
 * it completes calls that stay live and links recording files that were never reported.
 */
export const HANGUP_BUDGET_MS = 50_000
export const RECORDING_WAIT_MS = 15_000

export interface HangUpSteps {
  stopRecording(): Promise<void>
  finishCall(): Promise<void>
  saveRecording(): Promise<void>
}

/** The order of things at hang-up. The recording is saved even if finishing the call failed. */
export async function hangUp(steps: HangUpSteps, budgetMs = HANGUP_BUDGET_MS) {
  let timer: ReturnType<typeof setTimeout> | undefined
  const outOfTime = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`gave up after ${budgetMs / 1000} s`)), budgetMs)
  })
  const sequence = async () => {
    await steps.stopRecording()
    try {
      await steps.finishCall()
    } finally {
      await steps.saveRecording()
    }
  }
  try {
    await Promise.race([sequence(), outOfTime])
  } finally {
    clearTimeout(timer)
  }
}

/** Runs `finish` at most once, however many paths (hang-up, error, shutdown) ask for it. Never rejects. */
export function once(finish: () => Promise<void>, describe: string): () => Promise<void> {
  let done: Promise<void> | undefined
  return () => (done ??= finish().catch(e => console.error(`${describe}: ${message(e)}`)))
}
