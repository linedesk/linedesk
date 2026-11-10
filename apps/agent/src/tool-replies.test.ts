import { expect, test, vi } from 'vitest'
import { MESSAGE_SAVED_REPLY, URGENT_FLAGGED_REPLY, quietToolReplies } from './tool-replies.ts'

const executed = (...names: string[]) => ({ functionCalls: names.map(name => ({ name })), cancelToolReply: vi.fn() })
const quiet = new Set(['take_message', 'flag_urgent'])

test('no second LLM round after quiet tools when the assistant already spoke in this reply', () => {
  const say = vi.fn()
  const replies = quietToolReplies(quiet, say)
  replies.itemAdded('user')
  replies.itemAdded('assistant')
  const event = executed('take_message', 'flag_urgent')
  replies.toolsExecuted(event)
  expect(event.cancelToolReply).toHaveBeenCalledOnce()
  expect(say).not.toHaveBeenCalled()
})

test('a saved message without words gets the ready confirmation instead of a second round', () => {
  const say = vi.fn()
  const replies = quietToolReplies(quiet, say)
  replies.itemAdded('user')
  const event = executed('flag_urgent', 'take_message')
  replies.toolsExecuted(event)
  expect(event.cancelToolReply).toHaveBeenCalledOnce()
  expect(say).toHaveBeenCalledWith(MESSAGE_SAVED_REPLY)
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
  const replies = quietToolReplies(new Set(['take_message', 'flag_urgent', 'end_call']), say)
  replies.itemAdded('user')
  const hangUpOnly = executed('end_call')
  replies.toolsExecuted(hangUpOnly)
  expect(hangUpOnly.cancelToolReply).not.toHaveBeenCalled()

  replies.itemAdded('assistant')
  const mixed = executed('take_message', 'lookup')
  replies.toolsExecuted(mixed)
  expect(mixed.cancelToolReply).not.toHaveBeenCalled()
  expect(say).not.toHaveBeenCalled()
})
