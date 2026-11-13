import { expect, test } from 'vitest'
import { describeRealtimeUsage, realtimeUsageCounter } from './realtime-usage.ts'

test("adds up the realtime model's tokens per kind and ignores other metrics", () => {
  const usage = realtimeUsageCounter()
  const response = {
    type: 'realtime_model_metrics',
    inputTokenDetails: { audioTokens: 100, textTokens: 900, cachedTokensDetails: { audioTokens: 40, textTokens: 800 } },
    outputTokenDetails: { audioTokens: 300, textTokens: 30 },
  }
  usage.add(response)
  usage.add(response)
  usage.add({ type: 'eou_metrics' })
  usage.add({ type: 'realtime_model_metrics' }) // a cancelled response without details
  expect(usage.get()).toEqual({ responses: 3, inputAudio: 200, inputText: 1800, cachedAudio: 80, cachedText: 1600, outputAudio: 600, outputText: 60 })
  expect(describeRealtimeUsage('call_1', 'gpt-realtime', 61.4, usage.get())).toBe(
    'usage call_1: realtime gpt-realtime, 3 responses in 61 s, input audio 200 (cached 80), input text 1800 (cached 1600), output audio 600, output text 60',
  )
})
