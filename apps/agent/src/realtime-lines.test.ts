import { expect, test, vi } from 'vitest'
import type { GreetingAudio } from './greeting-cache.ts'
import { lineItemEvent, type RealtimeLineDeps, realtimeLineSpeaker } from './realtime-lines.ts'

const audio: GreetingAudio = { sampleRate: 24_000, channels: 1, samples: new Int16Array(480) }

/** A speaker with every dependency recorded; `events` is what went to the realtime model, in order. */
function speakerWith(overrides: Partial<RealtimeLineDeps> = {}) {
  const events: object[] = []
  const deps = {
    audio: vi.fn(async () => audio),
    play: vi.fn(async () => {}),
    askModel: vi.fn(async () => {}),
    model: () => ({ sendEvent: (event: object) => void events.push(event) }),
    repliesEvent: (on: boolean) => ({ replies: on }),
    callerTurns: () => 0,
    answer: vi.fn(),
    log: () => {},
    ...overrides,
  }
  return { say: realtimeLineSpeaker(deps), deps, events }
}

test('a fixed line is played as made, with the model held from answering meanwhile and told the line afterwards', async () => {
  const { say, deps, events } = speakerWith({
    play: vi.fn(async () => {
      // While the line plays, the model's replies are off.
      expect(events).toEqual([{ replies: false }])
    }),
  })
  await say('Are you still there?')
  expect(deps.play).toHaveBeenCalledWith('Are you still there?', audio, true)
  expect(deps.askModel).not.toHaveBeenCalled()
  expect(events).toEqual([{ replies: false }, lineItemEvent('Are you still there?'), { replies: true }])
  expect(deps.answer).not.toHaveBeenCalled()
})

test("the line goes into the conversation as the assistant's own words", () => {
  expect(lineItemEvent('Goodbye!')).toEqual({
    type: 'conversation.item.create',
    item: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Goodbye!' }] },
  })
})

test('a turn the caller finished while the line played is answered once the replies are back on', async () => {
  let turns = 0
  const { say, deps, events } = speakerWith({
    callerTurns: () => turns,
    play: vi.fn(async () => {
      turns++ // "Yes, I'm here" over the reminder
    }),
  })
  await say('Are you still there?')
  expect(events.at(-1)).toEqual({ replies: true })
  expect(deps.answer).toHaveBeenCalledOnce()
})

test('after the last line of a call the replies stay off and nothing is answered', async () => {
  let turns = 0
  const { say, deps, events } = speakerWith({ callerTurns: () => turns, play: vi.fn(async () => void turns++) })
  await say('Thanks for calling. Goodbye!', { allowInterruptions: false, last: true })
  expect(deps.play).toHaveBeenCalledWith('Thanks for calling. Goodbye!', audio, false)
  expect(events).toEqual([{ replies: false }, lineItemEvent('Thanks for calling. Goodbye!')])
  expect(deps.answer).not.toHaveBeenCalled()
})

test('the replies come back on even when playing fails', async () => {
  const { say, events } = speakerWith({ play: vi.fn(async () => Promise.reject(new Error('room closed'))) })
  await expect(say('Are you still there?')).rejects.toThrow('room closed')
  expect(events.at(-1)).toEqual({ replies: true })
})

test('when the line cannot be made the model is asked to say it, as before', async () => {
  const { say, deps, events } = speakerWith({ audio: vi.fn(async () => Promise.reject(new Error('401'))) })
  await say('Are you still there?')
  expect(deps.askModel).toHaveBeenCalledWith('Are you still there?')
  expect(deps.play).not.toHaveBeenCalled()
  expect(events).toEqual([])
})

test('a line that takes too long to make is said by the model', async () => {
  const { say, deps } = speakerWith({ audio: () => new Promise(() => {}), waitMs: 10 })
  await say('Are you still there?')
  expect(deps.askModel).toHaveBeenCalledOnce()
})

test('without a realtime session yet the model is asked', async () => {
  const { say, deps } = speakerWith({ model: () => null })
  await say('Goodbye!')
  expect(deps.askModel).toHaveBeenCalledOnce()
})

// LIN-359: the realtime model never connected, so asking it threw "AgentSession is not running", and nobody caught it.
test('a line the model can no longer be asked to say is logged, not thrown', async () => {
  const log = vi.fn()
  const { say } = speakerWith({
    model: () => null,
    askModel: () => {
      throw new Error('AgentSession is not running')
    },
    log,
  })
  await expect(say('Are you still there?')).resolves.toBeUndefined()
  expect(log).toHaveBeenCalledWith('fixed line not said: AgentSession is not running')
})
