// What a realtime call used, in tokens, from the model's metrics per response: logged once at hang-up, so the cost
// of a call minute can be worked out from the provider's prices (they differ per model and change over time). Also how
// often the conversation was cut (OpenAI's truncation, REALTIME_TRUNCATION in pipeline.ts) or turned into text by us
// (realtime-history.ts), and the share of input tokens read from the cache: what decides an Ultra call's cost (§8.6).

/** The parts of LiveKit's realtime_model_metrics this reads. */
export type RealtimeUsageMetrics = {
  type: string
  inputTokens?: number
  inputTokenDetails?: { audioTokens: number; textTokens: number; cachedTokensDetails?: { audioTokens: number; textTokens: number } }
  outputTokenDetails?: { audioTokens: number; textTokens: number }
}

export type RealtimeUsage = {
  responses: number
  inputAudio: number
  inputText: number
  cachedAudio: number
  cachedText: number
  outputAudio: number
  outputText: number
  /** Cuts by OpenAI: a reply that read much less than the one before, with no batch of ours in between. */
  truncations: number
  /** Batches of earlier turns turned into text (realtime-history.ts). */
  historyBatches: number
}

/**
 * A reply that reads less than this share of the input of the reply before: the conversation was cut. It only grows
 * otherwise (the instructions stay; a changed call notes block changes it by a few tokens).
 */
export const TRUNCATION_SHRINK = 0.7

const empty = (): RealtimeUsage => ({
  responses: 0, inputAudio: 0, inputText: 0, cachedAudio: 0, cachedText: 0, outputAudio: 0, outputText: 0, truncations: 0, historyBatches: 0,
})

/** The share of input tokens read from the cache, in whole percent (null: no input yet). */
export function cachedSharePct(u: RealtimeUsage): number | null {
  const input = u.inputAudio + u.inputText
  return input ? Math.round(((u.cachedAudio + u.cachedText) / input) * 100) : null
}

/** Adds up the realtime model's responses; any other metrics are ignored. */
export function realtimeUsageCounter() {
  const usage = empty()
  let lastInput: number | undefined
  let batchSinceLast = false
  return {
    add(metrics: RealtimeUsageMetrics) {
      if (metrics.type !== 'realtime_model_metrics') return
      const input = metrics.inputTokenDetails
      const output = metrics.outputTokenDetails
      const read = metrics.inputTokens ?? (input ? input.audioTokens + input.textTokens : 0)
      if (read > 0) {
        if (lastInput !== undefined && read < lastInput * TRUNCATION_SHRINK && !batchSinceLast) usage.truncations += 1
        lastInput = read
        batchSinceLast = false
      }
      usage.responses += 1
      usage.inputAudio += input?.audioTokens ?? 0
      usage.inputText += input?.textTokens ?? 0
      usage.cachedAudio += input?.cachedTokensDetails?.audioTokens ?? 0
      usage.cachedText += input?.cachedTokensDetails?.textTokens ?? 0
      usage.outputAudio += output?.audioTokens ?? 0
      usage.outputText += output?.textTokens ?? 0
    },
    /** Our own batch (realtime-history.ts): the next reply reads less, and that is not a cut by OpenAI. */
    addHistoryBatch() {
      usage.historyBatches += 1
      batchSinceLast = true
    },
    get: (): RealtimeUsage => ({ ...usage }),
  }
}

/**
 * One log line: `usage <call>: realtime <model>, <n> responses in <s> s, input audio … (cached …), …, cached <p>%,
 * truncations <n>, history batches <n>`.
 */
export function describeRealtimeUsage(callId: string, model: string, seconds: number, u: RealtimeUsage): string {
  return (
    `usage ${callId}: realtime ${model}, ${u.responses} responses in ${Math.round(seconds)} s, ` +
    `input audio ${u.inputAudio} (cached ${u.cachedAudio}), input text ${u.inputText} (cached ${u.cachedText}), ` +
    `output audio ${u.outputAudio}, output text ${u.outputText}, ` +
    `cached ${cachedSharePct(u) ?? '-'}%, truncations ${u.truncations}, history batches ${u.historyBatches}`
  )
}
