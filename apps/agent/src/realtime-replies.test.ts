import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { AUTO_REPLY_GRACE_MS, gateReplies, MAX_REPLY_WAIT_MS, realtimeReplyGate } from './realtime-replies.ts'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

const created = (byUs = false) => ({
  type: 'response.created',
  response: { metadata: byUs ? { client_event_id: 'e1' } : null },
})

/** A realtime session: its events, and the response.create it sends when asked for a reply. */
function fakeSession() {
  const events = new EventEmitter()
  const creates: string[] = []
  const session = {
    on: (name: string, listener: (event: object) => void) => events.on(name, listener),
    generateReply: vi.fn(async (instructions?: string, _options?: { signal?: AbortSignal }) => {
      creates.push(instructions ?? '')
      events.emit('openai_client_event_queued', { type: 'response.create' })
      return {}
    }),
  }
  const server = (event: object) => events.emit('openai_server_event_received', event)
  return { session, creates, server, client: (event: object) => events.emit('openai_client_event_queued', event) }
}

test('the greeting asked for as the caller stops talking waits for the model’s own answer instead of colliding', async () => {
  const { session, creates, server } = fakeSession()
  const gate = gateReplies(session)
  // The caller says "Hello?": the server commits the turn and is about to answer it itself.
  server({ type: 'input_audio_buffer.speech_stopped' })
  server({ type: 'input_audio_buffer.committed' })
  const greeting = session.generateReply('greeting')
  await vi.advanceTimersByTimeAsync(100)
  expect(creates).toEqual([])
  server(created())
  expect(gate.serverReplies()).toBe(1)
  await vi.advanceTimersByTimeAsync(5000)
  expect(creates).toEqual([])
  server({ type: 'response.done' })
  await greeting
  expect(creates).toEqual(['greeting'])
  expect(gate.asked()).toBe(1)
})

test('nothing runs: a reply is asked for at once', async () => {
  const { session, creates } = fakeSession()
  gateReplies(session)
  await session.generateReply('now')
  expect(creates).toEqual(['now'])
})

test('a turn the server does not answer (its replies off) holds nothing; an expected reply that never comes, only its grace', async () => {
  const { session, creates, server, client } = fakeSession()
  gateReplies(session)
  client({ type: 'session.update', session: { audio: { input: { turn_detection: { create_response: false } } } } })
  server({ type: 'input_audio_buffer.committed' })
  await session.generateReply('line')
  expect(creates).toEqual(['line'])
  client({ type: 'session.update', session: { audio: { input: { turn_detection: { create_response: true } } } } })
  server({ type: 'input_audio_buffer.committed' })
  const later = session.generateReply('after grace')
  await vi.advanceTimersByTimeAsync(AUTO_REPLY_GRACE_MS - 10)
  expect(creates).toEqual(['line'])
  await vi.advanceTimersByTimeAsync(20)
  await later
  expect(creates).toEqual(['line', 'after grace'])
})

test('a reply whose end never arrives holds a request at most MAX_REPLY_WAIT_MS', async () => {
  const { session, creates, server } = fakeSession()
  gateReplies(session)
  server(created(true))
  const reply = session.generateReply('late')
  await vi.advanceTimersByTimeAsync(MAX_REPLY_WAIT_MS - 1)
  expect(creates).toEqual([])
  await vi.advanceTimersByTimeAsync(2)
  await reply
  expect(creates).toEqual(['late'])
})

test('a request aborted while it waits is never sent', async () => {
  const { session, creates, server } = fakeSession()
  gateReplies(session)
  server(created())
  const abort = new AbortController()
  const reply = session.generateReply('dropped', { signal: abort.signal })
  abort.abort()
  await expect(reply).rejects.toThrow('generateReply aborted')
  server({ type: 'response.done' })
  expect(creates).toEqual([])
})

test('onReply tells who started a reply', () => {
  const gate = realtimeReplyGate()
  const seen: boolean[] = []
  const stop = gate.onReply(byServer => seen.push(byServer))
  gate.received(created())
  gate.received(created(true))
  stop()
  gate.received(created())
  expect(seen).toEqual([true, false])
})
