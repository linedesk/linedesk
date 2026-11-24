import { expect, test } from 'vitest'
import { liveCallsPerWorkspace } from './handlers.ts'

test('the calls at once per workspace come from LIVE_CALLS_PER_WORKSPACE, a whole number from 1 to 100, else 5', () => {
  expect(liveCallsPerWorkspace({})).toBe(5)
  expect(liveCallsPerWorkspace({ LIVE_CALLS_PER_WORKSPACE: '' })).toBe(5)
  expect(liveCallsPerWorkspace({ LIVE_CALLS_PER_WORKSPACE: ' 25 ' })).toBe(25)
  expect(liveCallsPerWorkspace({ LIVE_CALLS_PER_WORKSPACE: '1' })).toBe(1)
  expect(liveCallsPerWorkspace({ LIVE_CALLS_PER_WORKSPACE: '100' })).toBe(100)
  for (const bad of ['0', '101', '2.5', '-3', 'many'])
    expect(liveCallsPerWorkspace({ LIVE_CALLS_PER_WORKSPACE: bad })).toBe(5)
})
