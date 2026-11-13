// What a realtime call used, in tokens, from the model's metrics per response: logged once at hang-up, so the cost
// of a call minute can be worked out from the provider's prices (they differ per model and change over time).

/** The parts of LiveKit's realtime_model_metrics this reads. */
export type RealtimeUsageMetrics = {
  type: string
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
}

const empty = (): RealtimeUsage => ({ responses: 0, inputAudio: 0, inputText: 0, cachedAudio: 0, cachedText: 0, outputAudio: 0, outputText: 0 })

/** Adds up the realtime model's responses; any other metrics are ignored. */
export function realtimeUsageCounter() {
  const usage = empty()
  return {
    add(metrics: RealtimeUsageMetrics) {
      if (metrics.type !== 'realtime_model_metrics') return
      const input = metrics.inputTokenDetails
      const output = metrics.outputTokenDetails
      usage.responses += 1
      usage.inputAudio += input?.audioTokens ?? 0
      usage.inputText += input?.textTokens ?? 0
      usage.cachedAudio += input?.cachedTokensDetails?.audioTokens ?? 0
      usage.cachedText += input?.cachedTokensDetails?.textTokens ?? 0
      usage.outputAudio += output?.audioTokens ?? 0
      usage.outputText += output?.textTokens ?? 0
    },
    get: (): RealtimeUsage => ({ ...usage }),
  }
}

/** One log line: `usage <call>: realtime <model>, <n> responses in <s> s, input audio … (cached …), …`. */
export function describeRealtimeUsage(callId: string, model: string, seconds: number, u: RealtimeUsage): string {
  return (
    `usage ${callId}: realtime ${model}, ${u.responses} responses in ${Math.round(seconds)} s, ` +
    `input audio ${u.inputAudio} (cached ${u.cachedAudio}), input text ${u.inputText} (cached ${u.cachedText}), ` +
    `output audio ${u.outputAudio}, output text ${u.outputText}`
  )
}
