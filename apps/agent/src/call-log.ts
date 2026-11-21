// What happened in one call, and how it ends: every call that was started gets finished.
import type { VoiceStage } from '@linedesk/actions'
import type { CallResult, CallSession, CallTimings, Speaker } from './call-session.ts'
import type { ReplyTimes } from './turn-metrics.ts'
import { withRetry, type RetryOptions } from './retry.ts'
import { callerIdOf, hasCallbackNumber } from './callback-number.ts'
import {
  type CollectedDetail,
  mergeToolResults,
  summarizeCall,
  unsummarizedResult,
  voiceFailedResult,
  type CompleteJson,
  type TranscriptLine,
} from './summary.ts'

const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** Transcript lines and tool results of one call; writes each line through the API as it happens. */
/** How long the same words from the same speaker count as a repeat of one line (realtime reports some lines twice); shorter than the "Are you still there?" reminders (8 s apart by default). */
export const REPEAT_WINDOW_MS = 4000

/**
 * Whether a conversation line is one already written: the same item again, or the same words from the same speaker
 * within REPEAT_WINDOW_MS. On realtime calls the session reported a line twice, 0.9 s and 3.3 s apart (staging,
 * 2026-11-15): shorter than saying it, so it was said once and only written twice.
 */
export function repeatFilter(now: () => number = Date.now) {
  const ids = new Set<string>()
  const last = new Map<string, { text: string; at: number }>()
  return (item: { id?: string; role: string; text: string }): boolean => {
    if (item.id && ids.has(item.id)) return true
    if (item.id) ids.add(item.id)
    const before = last.get(item.role)
    const at = now()
    last.set(item.role, { text: item.text, at })
    return !!before && before.text.trim() === item.text.trim() && at - before.at < REPEAT_WINDOW_MS
  }
}

export class CallLog {
  readonly lines: TranscriptLine[] = []
  readonly messages: string[] = []
  urgent = false
  /** What the assistant booked on this call ("Repair visit, Tuesday, November 17 at 9:00 AM"). */
  readonly bookings: string[] = []
  /** The caller was put through to the on-call person (a warm transfer that connected). */
  transferred = false
  /** A transfer is ringing or the person is being briefed: the caller is on hold, so nobody asks them anything. */
  onHold = false
  /** The caller's name as they confirmed it in the name step (get_name): bookings go under it. */
  confirmedName: string | undefined
  /** A Shopify tool ran on this call (shopify-tools.ts): the call is about an order of the business's online store. */
  storeOrder = false
  /** The address the caller confirmed in the address step (get_address): the only one a booking takes. */
  confirmedAddress: string | undefined
  /** Phone numbers the caller confirmed with get_phone_number (E.164): the only ones the team gets besides caller ID. */
  readonly confirmedNumbers: string[] = []
  /** What the collection steps got, confirmed or a best guess: the summary takes the team's next step from these. */
  readonly details: CollectedDetail[] = []
  /** The value a collection step is getting right now (its label); null between steps. A call that ends meanwhile still files a call back. */
  collecting: string | null = null
  /** How long each reply took (ReplyTimes), sent at hang-up for the admin overview; `timing` says which pipeline and providers. */
  readonly replies: ReplyTimes[] = []
  timing: Omit<CallTimings, 'replies'> | null = null
  /** The first stage of the voice pipeline that failed on this call ("tts"); null while it works. */
  voiceFailed: VoiceStage | null = null
  private pending: Promise<unknown>[] = []

  private call: CallSession

  constructor(call: CallSession) {
    this.call = call
  }

  record(speaker: Speaker, text: string, tool?: string) {
    this.lines.push({ speaker, text })
    const write = this.call
      .append(speaker, text, tool ? { tool, label: text } : undefined)
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
/** What call.finish was sent; `held`: its news waits for finalizeCall. */
export type FinishedCall = { held: boolean; result: CallResult; named?: boolean }

/**
 * Summarizes the call and finishes it. `awaitTranscript`: the call is recorded, so the API may hold the news for the
 * after-call transcript (finalizeCall).
 */
export async function finishCall(
  call: CallSession,
  log: CallLog,
  complete: CompleteJson,
  retry?: RetryOptions,
  awaitTranscript = false,
): Promise<FinishedCall> {
  await log.flush()
  // The reply times are for the admin overview: a failure there never holds up finishing the call.
  if (log.timing && log.replies.length)
    void call
      .recordTimings({ ...log.timing, replies: log.replies })
      .catch(e => console.warn(`could not store the reply times of call ${call.callId}: ${message(e)}`))
  // Silent because the voice pipeline failed: a caller to call back, not a hang-up (nothing to summarize either).
  const silent = !log.lines.some(l => l.speaker === 'caller')
  // No caller ID and no number given: no action item asks the owner to call back (B4).
  const callbackKnown = hasCallbackNumber(callerIdOf(call), {
    confirmed: log.confirmedNumbers,
    saved: log.messages,
    country: call.country,
  })
  const summary =
    silent && log.voiceFailed
      ? voiceFailedResult(log.voiceFailed, call.teamLanguage)
      : await summarizeWithRetry(call, log.lines, log, complete, callbackKnown, retry).catch(e => {
          console.error(`could not summarize call ${call.callId}, finishing it without a summary: ${message(e)}`)
          return unsummarizedResult(log.lines, log.messages, call.teamLanguage, log.details)
        })
  const result = mergeToolResults(summary, log, callbackKnown, call.teamLanguage)
  // A silent call has no caller line to correct.
  const done = await withRetry(
    () =>
      call.finish({
        ...result,
        ...(awaitTranscript && !silent ? { awaitTranscript: true } : {}),
        // White-label own keys (S7): whose keys served the call; the API bills it $0 only when all were the partner's.
        ...(call.keySources ? { keySources: call.keySources } : {}),
      }),
    retry,
  )
  return { held: isHeld(done), result, named: hasFlag(done, 'named') }
}

/**
 * For a call whose news waits (FinishedCall.held), once its recording is reported: asks for the after-call transcript,
 * summarizes the corrected lines with the same prompt, then sends call.finalize, which sends the news. Any failure
 * leaves the first summary; call.finalize then only sends the news. Without it the API sends them after
 * AWAIT_TRANSCRIPT_MAX_SEC.
 */
export async function finalizeCall(
  call: CallSession,
  log: CallLog,
  complete: CompleteJson,
  finished: FinishedCall,
  recordingSaved: boolean,
  retry?: RetryOptions,
) {
  if (!call.finalize) return
  const corrected =
    recordingSaved && call.correctTranscript
      ? await call.correctTranscript().catch(e => {
          console.warn(`after-call transcript of call ${call.callId} failed, keeping the first summary: ${message(e)}`)
          return null
        })
      : null
  let better: CallResult | null = null
  const lines = corrected?.status === 'updated' ? withCorrectedCallerLines(log.lines, corrected.lines ?? []) : null
  if (lines) {
    const callbackKnown = hasCallbackNumber(callerIdOf(call), {
      confirmed: log.confirmedNumbers,
      saved: log.messages,
      country: call.country,
    })
    better = await summarizeWithRetry(call, lines, log, complete, callbackKnown, retry)
      .then(summary => mergeToolResults(summary, log, callbackKnown, call.teamLanguage))
      .catch(e => {
        console.warn(
          `summary of the after-call transcript of call ${call.callId} failed, keeping the first one: ${message(e)}`,
        )
        return null
      })
  }
  const first = finished.result
  await withRetry(
    () =>
      call.finalize!(
        better
          ? {
              title: better.title,
              summary: better.summary,
              outcome: better.outcome,
              urgency: better.urgency,
              actionItems: better.actionItems,
              fields: better.fields,
              // [] clears what the first summary flagged: the corrected transcript may have the reason or number.
              missing: better.missing ?? [],
              callerName: better.callerName,
              previous: {
                actionItems: (first.actionItems ?? []).map(item => item.text).slice(0, 200),
                ...(finished.named ? { callerName: first.callerName } : {}),
                urgency: first.urgency,
                title: first.title,
                summary: first.summary,
              },
            }
          : {},
      ),
    retry,
  )
}

/**
 * The lines the first summary had, with the caller's lines as the after-call transcript has them. The two lists are
 * matched by the caller's lines in order; when they differ in number (a line that never reached the API), null: the
 * first summary stays.
 */
export function withCorrectedCallerLines(
  own: readonly TranscriptLine[],
  corrected: readonly TranscriptLine[],
): TranscriptLine[] | null {
  const texts = corrected.filter(l => l.speaker === 'caller').map(l => l.text)
  if (!texts.length || texts.length !== own.filter(l => l.speaker === 'caller').length) return null
  let next = 0
  return own.map(line => (line.speaker === 'caller' ? { ...line, text: texts[next++]! } : line))
}

/** A timed-out request is not repeated: a second one would not fit into the hang-up budget. */
const isTimeout = (e: unknown) =>
  e instanceof Error && (e.name === 'TimeoutError' || /timeout|timed out/i.test(e.message))
export const SUMMARY_RETRY_DELAY_MS = 2000

/** Summarizes; a failed request (a rate limit, a bad answer) is tried once more after a short pause. */
async function summarizeWithRetry(
  call: CallSession,
  lines: TranscriptLine[],
  log: CallLog,
  complete: CompleteJson,
  callbackKnown: boolean,
  retry?: RetryOptions,
) {
  try {
    return await summarizeCall(lines, complete, log.messages, call.teamLanguage, {
      callbackKnown,
      details: log.details,
    })
  } catch (e) {
    if (isTimeout(e)) throw e
    console.warn(`summary of call ${call.callId} failed, trying once more: ${message(e)}`)
    const pause = retry?.wait ?? ((ms: number) => new Promise(resolve => setTimeout(resolve, ms)))
    await pause(SUMMARY_RETRY_DELAY_MS)
    return summarizeCall(lines, complete, log.messages, call.teamLanguage, { callbackKnown, details: log.details })
  }
}

/**
 * Everything after the caller is gone has to fit into the worker's shutdown window (60 s by default):
 *   stop the recording                      at once, so the file has no trailing audio
 *   summary                                 at most 15 s (the LLM request's timeout); a failure that is not a
 *                                           timeout is tried once more after 2 s; then finish without one
 *   call.finish                             4 attempts of at most 5 s each, 3.5 s of backoff in between
 *   wait for the recording file, report it  at most RECORDING_WAIT_MS, then call.setRecording
 *   only when call.finish held the news (after-call transcription on, finalizeCall):
 *     after-call transcript                 at most 30 s (call.correctTranscript), usually 2-10 s
 *     summary of the corrected lines        as above, only when caller lines changed
 *     call.finalize                         like call.finish
 * The whole sequence is cut off after HANGUP_BUDGET_MS. What did not fit is repaired by the API:
 * it completes calls that stay live, links recording files that were never reported, and sends held news after
 * AWAIT_TRANSCRIPT_MAX_SEC (the CALL_RELEASE job).
 */
export const HANGUP_BUDGET_MS = 50_000
export const RECORDING_WAIT_MS = 15_000

export interface HangUpSteps {
  stopRecording(): Promise<void>
  /** `{ held: true }`: the news waits for `finalize`. */
  finishCall(): Promise<unknown>
  /** true once the recording is reported. */
  saveRecording(): Promise<unknown>
  /** Only for a held call, after saveRecording: the corrected transcript's summary and the news. */
  finalize?(recordingSaved: boolean): Promise<void>
}

const hasFlag = (data: unknown, flag: 'held' | 'named') =>
  typeof data === 'object' && data !== null && flag in data && (data as Record<string, unknown>)[flag] === true
const isHeld = (finished: unknown) => hasFlag(finished, 'held')

/** The order of things at hang-up. The recording is saved even if finishing the call failed. */
export async function hangUp(steps: HangUpSteps, budgetMs = HANGUP_BUDGET_MS) {
  let timer: ReturnType<typeof setTimeout> | undefined
  const outOfTime = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`gave up after ${budgetMs / 1000} s`)), budgetMs)
  })
  const sequence = async () => {
    await steps.stopRecording()
    let held = false
    let saved: unknown = false
    try {
      held = isHeld(await steps.finishCall())
    } finally {
      saved = await steps.saveRecording()
    }
    if (held && steps.finalize) await steps.finalize(saved === true)
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
