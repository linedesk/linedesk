import { expect, test, vi } from 'vitest'
import { CallLog, finishCall, once } from './call-log.ts'
import type { CallSession } from './call-session.ts'
import type { CompleteJson } from './summary.ts'

const noWait = { wait: async () => {} }
const fakeCall = (finish = vi.fn(async () => {})) =>
  ({ callId: 'call_1', workspaceId: 'ws_1', append: vi.fn(async () => {}), finish }) as unknown as CallSession & { finish: typeof finish }

const answer = JSON.stringify({ title: 'Leak', summary: 'A leak.', outcome: 'callback', urgency: 'normal', action_items: ['Send a plumber'] })

function talkedCall(call: CallSession) {
  const log = new CallLog(call)
  log.record('agent', 'How can I help?')
  log.record('caller', 'My sink is leaking.')
  log.messages.push('Call back about the sink')
  log.urgent = true
  return log
}

test('finishes with the summary; messages taken and the urgent flag are kept', async () => {
  const call = fakeCall()
  const complete = vi.fn<CompleteJson>(async () => answer)
  await finishCall(call, talkedCall(call), complete, noWait)
  expect(complete.mock.calls[0]![1]).toContain('Action items already saved:\n- Call back about the sink')
  expect(call.finish).toHaveBeenCalledWith(expect.objectContaining({
    title: 'Leak', outcome: 'callback', urgency: 'urgent', actionItems: [{ text: 'Call back about the sink' }, { text: 'Send a plumber' }],
  }))
})

test('a timed-out summary is not repeated; the message taken becomes title and summary', async () => {
  const call = fakeCall()
  const complete = vi.fn<CompleteJson>(async () => { throw new Error('The operation was aborted due to timeout') })
  await finishCall(call, talkedCall(call), complete, noWait)
  expect(complete).toHaveBeenCalledTimes(1)
  expect(call.finish).toHaveBeenCalledWith(expect.objectContaining({
    title: 'Call back about the sink', summary: 'Call back about the sink', outcome: 'message', urgency: 'urgent', actionItems: [{ text: 'Call back about the sink' }],
  }))
})

test('a failed summary request is tried once more', async () => {
  const call = fakeCall()
  const complete = vi.fn<CompleteJson>().mockRejectedValueOnce(new Error('summary request failed (429): Provider returned error')).mockResolvedValue(answer)
  await finishCall(call, talkedCall(call), complete, noWait)
  expect(complete).toHaveBeenCalledTimes(2)
  expect(call.finish).toHaveBeenCalledWith(expect.objectContaining({ title: 'Leak', outcome: 'callback' }))
})

test('without a message taken, a failed summary finishes the call as answered', async () => {
  const call = fakeCall()
  const log = new CallLog(call)
  log.record('caller', 'Are you open on Sunday?')
  await finishCall(call, log, async () => { throw new Error('summary response was empty') }, noWait)
  expect(call.finish).toHaveBeenCalledWith(expect.objectContaining({ title: 'Call (summary unavailable)', outcome: 'answered', summary: 'Are you open on Sunday?' }))
})

test('a silent call after the voice failed is a call back, not a hang-up', async () => {
  const call = fakeCall()
  const log = new CallLog(call)
  log.record('agent', 'Thanks for calling. How can I help?')
  log.voiceFailed = 'voice'
  const complete = vi.fn<CompleteJson>(async () => answer)
  await finishCall(call, log, complete, noWait)
  expect(complete).not.toHaveBeenCalled()
  expect(call.finish).toHaveBeenCalledWith(expect.objectContaining({
    title: "Missed: the assistant's voice failed", outcome: 'callback',
    actionItems: [{ text: "Call the caller back: the assistant's voice failed on this call." }],
  }))
})

test('call.finish is retried until the API answers', async () => {
  const finish = vi.fn<() => Promise<void>>().mockRejectedValueOnce(new TypeError('fetch failed')).mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValue()
  const call = fakeCall(finish)
  await finishCall(call, talkedCall(call), async () => answer, noWait)
  expect(finish).toHaveBeenCalledTimes(3)
})

test('once runs the finish a single time and never rejects', async () => {
  const finish = vi.fn(async () => { throw new Error('API down') })
  const finishOnce = once(finish, 'could not finish call call_1')
  await expect(Promise.all([finishOnce(), finishOnce(), finishOnce()])).resolves.toBeDefined()
  expect(finish).toHaveBeenCalledTimes(1)
})

test('the reply times go out at hang-up with the pipeline and providers; a failure there does not stop the finish', async () => {
  const call = fakeCall()
  const recordTimings = vi.fn(async () => {
    throw new Error('API down')
  })
  Object.assign(call, { recordTimings })
  const log = new CallLog(call)
  log.timing = { pipeline: 'realtime', providers: { turn: 'openai_realtime', model: 'openai_realtime' } }
  log.replies.push({ at: '2026-11-12T18:00:00.000Z', turnMs: 500, modelMs: 300, serverMs: 20, totalMs: 820 })
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  await finishCall(call, log, async () => '{"title":"t","summary":"s","outcome":"answered"}', noWait)
  expect(recordTimings).toHaveBeenCalledWith({ pipeline: 'realtime', providers: { turn: 'openai_realtime', model: 'openai_realtime' }, replies: log.replies })
  expect(call.finish).toHaveBeenCalled()
  warn.mockRestore()
})
