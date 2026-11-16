import { expect, test, vi } from 'vitest'
import { spokenLines } from '@linedesk/actions'
import { URGENT_FLAGGED_NO_CALLER_ID_REPLY, URGENT_FLAGGED_REPLY, quietToolReplies } from './tool-replies.ts'

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

test('without caller ID (a browser demo or test call) the urgent line asks for a callback number, in the language spoken', () => {
  const say = vi.fn()
  const replies = quietToolReplies(quiet, say, () => spokenLines('fr'), { callerId: false })
  replies.itemAdded('user')
  replies.toolsExecuted(executed('flag_urgent'))
  expect(say).toHaveBeenCalledWith(
    "J'ai signalé cet appel comme urgent à l'équipe. À quel numéro pouvons-nous vous rappeler ?",
  )
  expect(say.mock.calls[0]![0]).not.toMatch(/depuis lequel vous appelez/)
  expect(URGENT_FLAGGED_NO_CALLER_ID_REPLY).toBe(
    "I've marked this as urgent for the team. What number can we call you back on?",
  )
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
