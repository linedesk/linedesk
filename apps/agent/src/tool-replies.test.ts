import { expect, test, vi } from 'vitest'
import { URGENT_FLAGGED_REPLY, quietToolReplies } from './tool-replies.ts'

const executed = (...names: string[]) => ({ functionCalls: names.map(name => ({ name })), cancelToolReply: vi.fn() })
const quiet = new Set(['flag_urgent'])

test('no second LLM round after a quiet tool when the assistant already spoke in this reply', () => {
  const say = vi.fn()
  const replies = quietToolReplies(quiet, say)
  replies.itemAdded('user')
  replies.itemAdded('assistant')
  const event = executed('flag_urgent')
  replies.toolsExecuted(event)
  expect(event.cancelToolReply).toHaveBeenCalledOnce()
  expect(say).not.toHaveBeenCalled()
})

test('an urgent flag alone without words gets its own ready line', () => {
  const say = vi.fn()
  const replies = quietToolReplies(quiet, say)
  replies.itemAdded('user')
  const flagOnly = executed('flag_urgent')
  replies.toolsExecuted(flagOnly)
  expect(flagOnly.cancelToolReply).toHaveBeenCalledOnce()
  expect(say).toHaveBeenCalledWith(URGENT_FLAGGED_REPLY)
})

test('the model still answers after end_call alone without words, or when another tool ran', () => {
  const say = vi.fn()
  const replies = quietToolReplies(new Set(['flag_urgent', 'end_call']), say)
  replies.itemAdded('user')
  const hangUpOnly = executed('end_call')
  replies.toolsExecuted(hangUpOnly)
  expect(hangUpOnly.cancelToolReply).not.toHaveBeenCalled()

  replies.itemAdded('assistant')
  const mixed = executed('flag_urgent', 'lookup')
  replies.toolsExecuted(mixed)
  expect(mixed.cancelToolReply).not.toHaveBeenCalled()
  expect(say).not.toHaveBeenCalled()
})

test('a realtime model (no ready lines): only the reply after a turn it already spoke in is skipped', () => {
  const replies = quietToolReplies(quiet, null)
  const cancel = vi.fn()
  replies.itemAdded('user')
  replies.toolsExecuted({ functionCalls: [{ name: 'flag_urgent' }], cancelToolReply: cancel })
  expect(cancel).not.toHaveBeenCalled()
  replies.itemAdded('assistant')
  replies.toolsExecuted({ functionCalls: [{ name: 'flag_urgent' }], cancelToolReply: cancel })
  expect(cancel).toHaveBeenCalledTimes(1)
})
