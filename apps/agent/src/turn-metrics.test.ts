import { expect, test } from 'vitest'
import { cascadedReplyTimer, type ReplyTimes } from './turn-metrics.ts'

test('three stages: a reply from the caller\'s last word to its audio, split into turn, model, voice and the agent', () => {
  let clock = 0
  const replies: ReplyTimes[] = []
  const timer = cascadedReplyTimer(r => replies.push(r), () => clock)
  // The caller stopped at 1000; Flux took the turn 400 ms later; first token 600 ms, first audio 200 ms; playing at 2300.
  timer.metrics({ type: 'eou_metrics', speechId: 's1', lastSpeakingTimeMs: 1000, endOfUtteranceDelayMs: 400 })
  timer.metrics({ type: 'llm_metrics', speechId: 's1', ttftMs: 600 })
  clock = 2300
  timer.speaking()
  expect(replies).toHaveLength(0) // the voice's metrics come after it started playing
  timer.metrics({ type: 'tts_metrics', speechId: 's1', ttfbMs: 200 })
  expect(replies).toEqual([{ at: new Date(1000).toISOString(), turnMs: 400, modelMs: 600, voiceMs: 200, serverMs: 100, totalMs: 1300 }])
  // A cancelled reply and audio with no end of turn before it (the greeting) give nothing.
  timer.metrics({ type: 'llm_metrics', speechId: 's2', ttftMs: 500, cancelled: true })
  timer.speaking()
  expect(replies).toHaveLength(1)
})

test('three stages: parts that add up to more than the total (a reply matched wrong) give no time', () => {
  let clock = 0
  const replies: ReplyTimes[] = []
  const timer = cascadedReplyTimer(r => replies.push(r), () => clock)
  timer.metrics({ type: 'eou_metrics', speechId: 's1', lastSpeakingTimeMs: 1000, endOfUtteranceDelayMs: 400 })
  timer.metrics({ type: 'llm_metrics', speechId: 's1', ttftMs: 900 })
  clock = 1500 // playing only 500 ms after the last word, though turn and model alone took 1300 ms
  timer.speaking()
  timer.metrics({ type: 'tts_metrics', speechId: 's1', ttfbMs: 200 })
  expect(replies).toEqual([])
})

test("three stages: a voice not measured (-1, the fallback voice spoke) is left out with the agent's share, never sent negative", () => {
  let clock = 0
  const replies: ReplyTimes[] = []
  const timer = cascadedReplyTimer(r => replies.push(r), () => clock)
  timer.metrics({ type: 'eou_metrics', speechId: 's1', lastSpeakingTimeMs: 1000, endOfUtteranceDelayMs: 400 })
  timer.metrics({ type: 'llm_metrics', speechId: 's1', ttftMs: 600 })
  clock = 2300
  timer.speaking()
  timer.metrics({ type: 'tts_metrics', speechId: 's1', ttfbMs: -1 })
  expect(replies).toEqual([{ at: new Date(1000).toISOString(), turnMs: 400, modelMs: 600, totalMs: 1300 }])
  // The same for a model not measured.
  timer.metrics({ type: 'eou_metrics', speechId: 's2', lastSpeakingTimeMs: 5000, endOfUtteranceDelayMs: 300 })
  timer.metrics({ type: 'llm_metrics', speechId: 's2', ttftMs: -1 })
  timer.metrics({ type: 'tts_metrics', speechId: 's2', ttfbMs: 200 })
  clock = 6000
  timer.speaking()
  expect(replies[1]).toEqual({ at: new Date(5000).toISOString(), turnMs: 300, voiceMs: 200, totalMs: 1000 })
  for (const reply of replies) for (const part of Object.values(reply)) if (typeof part === 'number') expect(part).toBeGreaterThanOrEqual(0)
})

test('three stages: no moment the caller stopped speaking (LiveKit reports 0) gives no time, not one of decades', () => {
  const replies: ReplyTimes[] = []
  const timer = cascadedReplyTimer(r => replies.push(r), () => 1_794_732_000_000)
  timer.metrics({ type: 'eou_metrics', speechId: 's1', lastSpeakingTimeMs: 0, endOfUtteranceDelayMs: 400 })
  timer.metrics({ type: 'llm_metrics', speechId: 's1', ttftMs: 600 })
  timer.metrics({ type: 'tts_metrics', speechId: 's1', ttfbMs: 200 })
  timer.speaking()
  expect(replies).toEqual([])
})
