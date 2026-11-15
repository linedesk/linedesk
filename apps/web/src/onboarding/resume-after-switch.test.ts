import { expect, test } from 'vitest'
import { clearResume, peekResume, RESUME_MAX_AGE_MS, saveResume } from './resume-after-switch.ts'

const memory = () => {
  const items = new Map<string, string>()
  return {
    getItem: (k: string) => items.get(k) ?? null,
    setItem: (k: string, v: string) => void items.set(k, v),
    removeItem: (k: string) => void items.delete(k),
  }
}

test('a row button clicked for another workspace carries on after the reload into it, once (LIN-237)', () => {
  const store = memory()
  saveResume('ws_2', 'test_call', store, 1_000)
  // Only in the workspace it was clicked for.
  expect(peekResume('ws_1', store, 2_000)).toBeNull()
  expect(peekResume(null, store, 2_000)).toBeNull()
  expect(peekResume('ws_2', store, 2_000)).toBe('test_call')
  // Used: never again.
  clearResume(store)
  expect(peekResume('ws_2', store, 2_000)).toBeNull()
  saveResume('ws_2', 'forwarding', store, 1_000)
  expect(peekResume('ws_2', store, 1_500)).toBe('forwarding')
})

test('a leftover from long ago or a broken entry starts nothing', () => {
  const store = memory()
  saveResume('ws_2', 'forwarding', store, 1_000)
  expect(peekResume('ws_2', store, 1_000 + RESUME_MAX_AGE_MS + 1)).toBeNull()
  expect(peekResume('ws_2', store, 500)).toBeNull()
  store.setItem('linedesk.agentSetup.resume', '{not json')
  expect(peekResume('ws_2', store)).toBeNull()
  store.setItem('linedesk.agentSetup.resume', JSON.stringify({ workspaceId: 'ws_2', action: 'delete', at: Date.now() }))
  expect(peekResume('ws_2', store)).toBeNull()
})

test('without session storage (blocked, private mode) the click just switches', () => {
  const throwing = {
    getItem: () => {
      throw new Error('blocked')
    },
    setItem: () => {
      throw new Error('blocked')
    },
    removeItem: () => {
      throw new Error('blocked')
    },
  }
  expect(() => saveResume('ws_2', 'test_call', throwing)).not.toThrow()
  expect(peekResume('ws_2', throwing)).toBeNull()
  expect(() => clearResume(throwing)).not.toThrow()
  expect(peekResume('ws_2', null)).toBeNull()
})
