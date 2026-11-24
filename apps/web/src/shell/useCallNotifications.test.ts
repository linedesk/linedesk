import type { Call } from '@linedesk/db/types'
import { expect, test } from 'vitest'
import { newlyFinished } from './useCallNotifications.ts'

const since = Date.parse('2026-11-10T17:00:00Z')
const call = (id: string, over: Partial<Call> = {}) =>
  ({
    id,
    status: 'completed',
    ended_at: '2026-11-10T17:05:00Z',
    deleted_at: null,
    source: 'phone',
    outcome: 'message',
    ...over,
  }) as Call

test('only calls that just finished are news', () => {
  const before = new Map<string, Call['status']>([
    ['live', 'live'],
    ['old', 'completed'],
  ])
  const calls = [
    call('live'), // was live, now completed
    call('old'), // was already completed
    call('history', { ended_at: '2026-11-09T10:00:00Z' }), // first sync of a fresh browser
    call('test', { source: 'test' }),
    call('spam', { outcome: 'spam' }),
    call('still-live', { status: 'live', ended_at: null }),
    call('new'), // arrived finished
  ]
  expect(newlyFinished(calls, before, since).map(c => c.id)).toEqual(['live', 'new'])
})
