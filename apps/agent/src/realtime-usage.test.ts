import { expect, test } from 'vitest'
import { cachedSharePct, describeRealtimeUsage, realtimeUsageCounter } from './realtime-usage.ts'

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
  expect(usage.get()).toEqual({ responses: 3, inputAudio: 200, inputText: 1800, cachedAudio: 80, cachedText: 1600, outputAudio: 600, outputText: 60, truncations: 0, historyBatches: 0 })
  expect(describeRealtimeUsage('call_1', 'gpt-realtime', 61.4, usage.get())).toBe(
    'usage call_1: realtime gpt-realtime, 3 responses in 61 s, input audio 200 (cached 80), input text 1800 (cached 1600), output audio 600, output text 60, cached 84%, truncations 0, history batches 0',
  )
})

const reply = (inputTokens: number, cached = 0) => ({
  type: 'realtime_model_metrics',
  inputTokens,
  inputTokenDetails: { audioTokens: inputTokens - 3000, textTokens: 3000, cachedTokensDetails: { audioTokens: 0, textTokens: cached } },
})

test("a reply that reads much less than the one before is a cut by OpenAI, unless it follows a batch of ours", () => {
  const usage = realtimeUsageCounter()
  usage.add(reply(3500))
  usage.add(reply(7000))
  usage.add(reply(5500)) // shrank by a few tokens' worth: not a cut
  usage.add(reply(3600)) // under 70 % of 5,500: OpenAI cut
  usage.add(reply(7000))
  usage.addHistoryBatch()
  usage.add(reply(4200)) // our batch made it smaller
  usage.add(reply(2500)) // and OpenAI cut again
  expect(usage.get()).toMatchObject({ responses: 7, truncations: 2, historyBatches: 1 })
})

test('the cached share is of all input tokens, none before the first reply', () => {
  const usage = realtimeUsageCounter()
  expect(cachedSharePct(usage.get())).toBeNull()
  expect(describeRealtimeUsage('c', 'gpt-realtime', 0, usage.get())).toMatch(/cached -%, truncations 0, history batches 0$/)
  usage.add(reply(4000, 3000))
  usage.add(reply(6000, 3000))
  expect(cachedSharePct(usage.get())).toBe(60)
})
