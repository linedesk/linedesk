// What happened in one call, and how it ends: every call that was started gets finished.
import type { CallSession, Speaker } from './call-session.ts'
import { withRetry, type RetryOptions } from './retry.ts'
import { mergeToolResults, summarizeCall, unsummarizedResult, type CompleteJson, type TranscriptLine } from './summary.ts'

const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** Transcript lines and tool results of one call; writes each line through the API as it happens. */
export class CallLog {
  readonly lines: TranscriptLine[] = []
  readonly messages: string[] = []
  urgent = false
  private pending: Promise<unknown>[] = []

  constructor(private call: CallSession) {}

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
  const summary = await summarizeCall(log.lines, complete, log.messages).catch(e => {
    console.error(`could not summarize call ${call.callId}: ${message(e)}`)
    return unsummarizedResult(log.lines)
  })
  await withRetry(() => call.finish(mergeToolResults(summary, log)), retry)
}

/** Runs `finish` at most once, however many paths (hang-up, error, shutdown) ask for it. Never rejects. */
export function once(finish: () => Promise<void>, describe: string): () => Promise<void> {
  let done: Promise<void> | undefined
  return () => (done ??= finish().catch(e => console.error(`${describe}: ${message(e)}`)))
}
