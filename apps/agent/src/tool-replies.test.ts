import { expect, test, vi } from 'vitest'
import { quietToolReplies } from './tool-replies.ts'

const executed = (...names: string[]) => ({ functionCalls: names.map(name => ({ name })), cancelToolReply: vi.fn() })

test('no second LLM round after a quiet tool when the assistant already spoke in this reply', () => {
  const replies = quietToolReplies(new Set(['take_message', 'flag_urgent']))
  replies.itemAdded('user')
  replies.itemAdded('assistant')
  const event = executed('take_message', 'flag_urgent')
  replies.toolsExecuted(event)
  expect(event.cancelToolReply).toHaveBeenCalledOnce()
})

test('the follow-up stays when the assistant said nothing yet, or another tool ran', () => {
  const replies = quietToolReplies(new Set(['take_message']))
  replies.itemAdded('assistant')
  replies.itemAdded('user')
  const silent = executed('take_message')
  replies.toolsExecuted(silent)
  expect(silent.cancelToolReply).not.toHaveBeenCalled()

  replies.itemAdded('assistant')
  const mixed = executed('take_message', 'end_call')
  replies.toolsExecuted(mixed)
  expect(mixed.cancelToolReply).not.toHaveBeenCalled()
})
