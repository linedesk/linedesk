import type { Call } from '@callfront/db/types'
import { describe, expect, it } from 'vitest'
import { countsFor, listFor, tabOf } from './inbox-model.ts'

const now = new Date('2026-11-10T12:00:00Z')
const call = (over: Partial<Call>) => ({
  id: 'c', status: 'completed', outcome: 'answered', urgency: 'normal', inbox_state: 'open', reminder_at: null,
  deleted_at: null, started_at: '2026-11-10 10:00:00+00', action_items: [], ...over,
}) as Call

describe('inbox views', () => {
  it('puts calls where a person has to act in Needs you', () => {
    for (const c of [call({ status: 'live' }), call({ urgency: 'urgent', outcome: 'booked' }), call({ outcome: 'callback' }), call({ outcome: 'message' }), call({ outcome: 'hangup' })]) {
      expect(tabOf(c, now)).toBe('you')
    }
  })
  it('sorts the rest into Handled, Spam, Reminders and Done', () => {
    expect(tabOf(call({ outcome: 'booked' }), now)).toBe('ai')
    expect(tabOf(call({ outcome: 'spam', urgency: 'urgent' }), now)).toBe('spam')
    expect(tabOf(call({ outcome: 'callback', reminder_at: '2026-11-10T13:00:00.000Z' }), now)).toBe('reminders')
    expect(tabOf(call({ outcome: 'callback', reminder_at: '2026-11-10 11:00:00+00' }), now)).toBe('you') // reminder passed
    expect(tabOf(call({ outcome: 'callback', inbox_state: 'done' }), now)).toBe('done')
  })
  it('lists newest first with live calls on top and hides deleted calls', () => {
    const calls = [
      call({ id: 'old', outcome: 'callback', started_at: '2026-11-09 10:00:00+00' }),
      call({ id: 'live', status: 'live', started_at: '2026-11-09 09:00:00+00' }),
      call({ id: 'new', outcome: 'callback' }),
      call({ id: 'gone', outcome: 'callback', deleted_at: '2026-11-10 11:00:00+00' }),
    ]
    expect(listFor(calls, 'you', now).map(c => c.id)).toEqual(['live', 'new', 'old'])
    expect(countsFor(calls, now).you).toBe(3)
  })
})
