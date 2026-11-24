// Settings › Assistant: "Callers hear" shows the whole opening as a call says it, the recording notice included.
import type { Assistant } from '@linedesk/db/types'
import { expect, test, vi } from 'vitest'

vi.mock('../cachedQuery.ts', () => ({
  useQuery: () => ({ data: undefined, error: null, reload: () => {} }),
  refreshQuery: () => {},
}))
vi.mock('./settings-api.ts', () => ({
  readAction: vi.fn(),
  useWriteAction: () => vi.fn(),
  useWorkspaceSettings: () => ({ data: {}, error: null, reload: async () => {} }),
}))

const { heardGreeting } = await import('./AssistantSettings.tsx')
const { draftOf } = await import('./assistantDraft.ts')

const greeting = 'Thanks for calling Brightwater. This is Maya, the AI assistant. How can I help?'
const draft = (over: Partial<Assistant> = {}) =>
  draftOf({
    id: 'as1',
    name: 'Maya',
    greeting,
    business_profile: {},
    voice: { provider: 'elevenlabs', voice_id: '' },
    ...over,
  } as Assistant)

test('the notice comes before the closing question, as a call says it', () => {
  expect(heardGreeting(greeting, draft(), true)).toBe(
    'Thanks for calling Brightwater. This is Maya, the AI assistant. This call may be recorded and transcribed. How can I help?',
  )
  expect(
    heardGreeting(greeting, draft({ recording_notice: 'Calls are recorded.' } as Partial<Assistant>), true),
  ).toContain('AI assistant. Calls are recorded. How can I help?')
})

test('without the notice (off, or calls not recorded) it is the greeting alone', () => {
  expect(heardGreeting(greeting, draft({ recording_notice_on: false } as Partial<Assistant>), true)).toBe(greeting)
  expect(heardGreeting(greeting, draft(), false)).toBe(greeting)
  expect(heardGreeting('  ', draft(), true)).toBe('')
})
