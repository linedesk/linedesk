import { EventEmitter } from 'node:events'
import { z } from 'zod'
import { voice } from '@livekit/agents'
import { TOOL_MAX_WAIT_MS } from '@linedesk/actions'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { Reply } from './hang-up.ts'
import {
  FILLER_AFTER_MS,
  STILL_AFTER_MS,
  TOO_SLOW_REPLY,
  type FillerSession,
  isSlowTool,
  toolFiller,
  withFillers,
} from './tool-filler.ts'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

const runOf = () => ({ speechHandle: replyOf(), disallowInterruptions: vi.fn() })

const replyOf = (words = ''): Reply => ({
  done: () => false,
  addDoneCallback: () => {},
  chatItems: words ? [{ type: 'message', role: 'assistant', textContent: words }] : [],
})

function session(agentState = 'thinking') {
  const events = new EventEmitter()
  const s = Object.assign(events, { agentState, userState: 'listening' })
  const callerSays = () =>
    events.emit(voice.AgentSessionEventTypes.ConversationItemAdded, { item: { type: 'message', role: 'user' } })
  return { session: s as unknown as FillerSession & { agentState: string; userState: string }, callerSays }
}

test('the slow tools: lookups and the calendar; not end_call, collection steps or transfer_call', () => {
  for (const name of [
    'lookup_order_status',
    'find_slots',
    'book_appointment',
    'cancel_appointment',
    'reschedule_appointment',
  ])
    expect(isSlowTool(name)).toBe(true)
  for (const name of ['end_call', 'flag_urgent', 'get_name', 'confirm_digits', 'transfer_call'])
    expect(isSlowTool(name)).toBe(false)
})

// LIN-341: the lookup ran with no words before it, and the caller heard seconds of silence.
test('a slow tool with no words before it: the filler, once it runs a moment', async () => {
  const { session: s } = session()
  const say = vi.fn(async (_line: string) => {})
  toolFiller(s, say)(replyOf(), () => true, { waiting: ' Let me look up order 1234. ' })
  await vi.advanceTimersByTimeAsync(FILLER_AFTER_MS - 1)
  expect(say).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  expect(say).toHaveBeenCalledExactlyOnceWith('Let me look up order 1234.')
})

test('no filler when the tool answered quickly, the assistant said something, its words still play, the caller talks, or the model wrote no sentence', async () => {
  const quiet = session()
  const say = vi.fn(async (_line: string) => {})
  const line = 'Let me check.'
  toolFiller(quiet.session, say)(replyOf(), () => false, { waiting: line })
  toolFiller(quiet.session, say)(replyOf('One moment, let me check.'), () => true, { waiting: line })
  toolFiller(quiet.session, say)(replyOf(), () => true, { waiting: null })
  toolFiller(quiet.session, say)(replyOf(), () => true, { waiting: '  ' })
  const speaking = session('speaking')
  toolFiller(speaking.session, say)(replyOf(), () => true, { waiting: line })
  const talking = session()
  talking.session.userState = 'speaking'
  toolFiller(talking.session, say)(replyOf(), () => true, { waiting: line })
  await vi.advanceTimersByTimeAsync(FILLER_AFTER_MS * 2)
  expect(say).not.toHaveBeenCalled()
})

test('never twice: one filler per reply and per caller turn', async () => {
  const { session: s, callerSays } = session()
  const say = vi.fn(async (_line: string) => {})
  const started = toolFiller(s, say)
  const reply = replyOf()
  started(reply, () => true, { waiting: 'Let me check.' })
  started(reply, () => true, { waiting: 'Let me check.' }) // a second lookup in the same reply
  await vi.advanceTimersByTimeAsync(FILLER_AFTER_MS)
  started(replyOf(), () => true, { waiting: 'Let me check.' }) // the model chains another tool before the caller spoke
  await vi.advanceTimersByTimeAsync(FILLER_AFTER_MS)
  expect(say).toHaveBeenCalledOnce()
  callerSays()
  started(replyOf(), () => true, { waiting: 'Let me check.' })
  await vi.advanceTimersByTimeAsync(FILLER_AFTER_MS)
  expect(say).toHaveBeenCalledTimes(2)
})

test('withFillers: the slow tools get say_while_waiting, never pass it on, and report when they are done', async () => {
  const started = vi.fn()
  const lookup = {
    type: 'function',
    description: 'lookup',
    parameters: z.object({ order: z.string() }),
    execute: vi.fn(async () => 'answer'),
  }
  const endCall = { type: 'function', description: 'end', execute: vi.fn(async () => 'bye') }
  // biome-ignore lint/suspicious/noExplicitAny: test doubles of LiveKit tools
  const tools = withFillers({ lookup_order_status: lookup as any, end_call: endCall as any }, started)
  expect(tools.end_call).toBe(endCall)
  const ctx = runOf()
  const { speechHandle } = ctx
  const args = { order: '1234', say_while_waiting: 'Let me look up order 1234.', say_if_slow: 'Still on it.' }
  // biome-ignore lint/suspicious/noExplicitAny: a minimal ToolOptions
  await expect(tools.lookup_order_status!.execute(args, { ctx } as any)).resolves.toBe('answer')
  // LIN-341: a "hello?" while the lookup runs must not cancel it.
  expect(ctx.disallowInterruptions).toHaveBeenCalledOnce()
  expect(lookup.execute).toHaveBeenCalledWith({ order: '1234' }, expect.anything())
  expect(started).toHaveBeenCalledWith(speechHandle, expect.any(Function), {
    waiting: 'Let me look up order 1234.',
    slow: 'Still on it.',
  })
  expect(Object.keys((tools.lookup_order_status!.parameters as z.ZodObject).shape)).toEqual([
    'order',
    'say_while_waiting',
    'say_if_slow',
  ])
  expect(started.mock.calls[0]![1]()).toBe(false)
  expect(tools.lookup_order_status!.description).toBe('lookup')
})

test('a long wait: the caller hears once that it takes longer, never over speech, never once done', async () => {
  const { session: s } = session()
  const say = vi.fn(async (_line: string) => {})
  let running = true
  toolFiller(s, say)(replyOf('Let me check.'), () => running, { waiting: 'Let me check.', slow: 'Still on it.' })
  await vi.advanceTimersByTimeAsync(STILL_AFTER_MS - 1)
  expect(say).not.toHaveBeenCalled() // the assistant spoke before the tool: no first filler
  await vi.advanceTimersByTimeAsync(1)
  expect(say).toHaveBeenLastCalledWith('Still on it.')
  await vi.advanceTimersByTimeAsync(20_000)
  expect(say).toHaveBeenCalledTimes(1) // once only
  running = false
})

test('the long-wait line waits while someone speaks, and is dropped once the tool is done', async () => {
  const { session: s } = session()
  const say = vi.fn(async (_line: string) => {})
  let running = true
  toolFiller(s, say)(replyOf('Let me check.'), () => running, { slow: 'Still on it.' })
  s.agentState = 'speaking'
  await vi.advanceTimersByTimeAsync(STILL_AFTER_MS + 2000)
  expect(say).not.toHaveBeenCalled() // still speaking: it waits
  s.agentState = 'thinking'
  await vi.advanceTimersByTimeAsync(1000)
  expect(say).toHaveBeenCalledTimes(1)
  running = false
  await vi.advanceTimersByTimeAsync(20_000)
  expect(say).toHaveBeenCalledTimes(1)
})

// LIN-341: the caller never waits longer than TOOL_MAX_WAIT_MS for another system.
test('a slow tool that runs too long is cut off: the model is told it did not finish, and the long-wait lines stop', async () => {
  const started = vi.fn()
  const book = {
    type: 'function',
    description: 'book',
    parameters: z.object({ start: z.string() }),
    execute: vi.fn(() => new Promise<string>(() => {})), // the calendar never answers
  }
  // biome-ignore lint/suspicious/noExplicitAny: a test double of a LiveKit tool
  const tools = withFillers({ book_appointment: book as any }, started)
  // biome-ignore lint/suspicious/noExplicitAny: a minimal ToolOptions
  const result = tools.book_appointment!.execute({ start: '10:00' }, { ctx: runOf() } as any)
  let done = false
  result.then(() => (done = true))
  await vi.advanceTimersByTimeAsync(TOOL_MAX_WAIT_MS - 1)
  expect(done).toBe(false)
  expect(started.mock.calls[0]![1]()).toBe(true)
  await vi.advanceTimersByTimeAsync(1)
  await expect(result).resolves.toBe(TOO_SLOW_REPLY)
  expect(started.mock.calls[0]![1]()).toBe(false)
})
