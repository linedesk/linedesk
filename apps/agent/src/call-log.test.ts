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

test('a failed or timed-out summary still finishes the call', async () => {
  const call = fakeCall()
  await finishCall(call, talkedCall(call), async () => { throw new Error('The operation was aborted due to timeout') }, noWait)
  expect(call.finish).toHaveBeenCalledWith(expect.objectContaining({
    title: 'Call (summary unavailable)', summary: 'My sink is leaking.', urgency: 'urgent', actionItems: [{ text: 'Call back about the sink' }],
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
