import type { Call } from '@callfront/db/types'
import { describe, expect, it } from 'vitest'
import { countsFor, listFor, resolveCursor, statusLabel, tabOf } from './inbox-model.ts'

const now = new Date('2026-11-10T12:00:00Z')
const call = (over: Partial<Call>) => ({
  id: 'c', status: 'completed', outcome: 'answered', urgency: 'normal', inbox_state: 'open', reminder_at: null, reminder_label: null,
  deleted_at: null, started_at: '2026-11-10 10:00:00+00', from_number: '+15035550100', direction: 'in', action_items: [], ...over,
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
      call({ id: 'old', outcome: 'callback', started_at: '2026-11-10 08:00:00+00' }),
      call({ id: 'live', status: 'live', started_at: '2026-11-10 07:00:00+00' }),
      call({ id: 'new', outcome: 'callback' }),
      call({ id: 'gone', outcome: 'callback', deleted_at: '2026-11-10 11:00:00+00' }),
    ]
    expect(listFor(calls, 'you', now).map(c => c.id)).toEqual(['live', 'new', 'old'])
    expect(countsFor(calls, now).you).toBe(3)
  })
})

describe('order inside a day', () => {
  const at = (hour: number) => `2026-11-10 ${String(hour).padStart(2, '0')}:00:00+00`
  it('ranks Needs you: live, urgent, new-caller callbacks, other callbacks, messages, hang-ups', () => {
    const calls = [
      call({ id: 'hangup', outcome: 'hangup', from_number: '+1', started_at: at(11) }),
      call({ id: 'message', outcome: 'message', from_number: '+2', started_at: at(10) }),
      call({ id: 'known-callback', outcome: 'callback', from_number: '+3', started_at: at(9) }),
      call({ id: 'new-callback', outcome: 'callback', from_number: '+4', started_at: at(8) }),
      call({ id: 'urgent', outcome: 'booked', urgency: 'urgent', from_number: '+5', started_at: at(7) }),
      call({ id: 'live', status: 'live', outcome: null, from_number: '+6', started_at: at(6) }),
      call({ id: 'earlier-from-3', outcome: 'answered', inbox_state: 'done', from_number: '+3', started_at: '2026-11-02 09:00:00+00' }),
    ]
    expect(listFor(calls, 'you', now).map(c => c.id)).toEqual(['live', 'urgent', 'new-callback', 'known-callback', 'message', 'hangup'])
  })
  it('keeps day groups ahead of priority and sorts other views by time only', () => {
    const calls = [
      call({ id: 'yesterday-urgent', outcome: 'callback', urgency: 'urgent', started_at: '2026-11-09 10:00:00+00' }),
      call({ id: 'today-hangup', outcome: 'hangup', started_at: at(9) }),
      call({ id: 'handled-old', outcome: 'booked', started_at: at(8) }),
      call({ id: 'handled-new', outcome: 'answered', started_at: at(10) }),
    ]
    expect(listFor(calls, 'you', now).map(c => c.id)).toEqual(['today-hangup', 'yesterday-urgent'])
    expect(listFor(calls, 'ai', now).map(c => c.id)).toEqual(['handled-new', 'handled-old'])
  })
})

describe('status column', () => {
  const label = (over: Partial<Call>, tab: 'you' | 'ai' = 'you') => statusLabel(call(over), tab, 'Maya', now)
  it('shows what matters most', () => {
    expect(label({ outcome: 'callback', reminder_at: '2026-11-10T13:00:00.000Z', reminder_label: 'Later today' })).toEqual({ text: 'Later today', tone: 'neutral' })
    expect(label({ outcome: 'callback', urgency: 'urgent' })).toEqual({ text: 'Urgent callback', tone: 'danger' })
    expect(label({ outcome: 'hangup' })).toEqual({ text: 'Missed', tone: 'danger' })
    expect(label({ outcome: 'spam' })).toEqual({ text: 'Blocked', tone: 'neutral' })
    expect(label({ outcome: 'callback', action_items: [{ text: 'Call back' }] })).toEqual({ text: 'Call back', tone: 'next' })
    expect(label({ outcome: 'answered' }, 'ai')).toEqual({ text: 'Resolved by Maya', tone: 'quiet' })
  })
  it('drops the reminder label once the reminder has passed', () => {
    expect(label({ outcome: 'callback', reminder_at: '2026-11-10 11:00:00+00', reminder_label: 'Later today' }).text).toBe('Follow-up')
  })
})

describe('older days', () => {
  it('ranks by priority inside each calendar day, not across all earlier days', () => {
    const calls = [
      call({ id: 'nov3-hangup', outcome: 'hangup', started_at: '2026-11-03 18:00:00+00' }),
      call({ id: 'nov3-urgent', outcome: 'callback', urgency: 'urgent', started_at: '2026-11-03 17:00:00+00' }),
      call({ id: 'nov5-hangup', outcome: 'hangup', started_at: '2026-11-05 18:00:00+00' }),
      call({ id: 'nov5-message', outcome: 'message', started_at: '2026-11-05 17:00:00+00' }),
    ]
    expect(listFor(calls, 'you', now).map(c => c.id)).toEqual(['nov5-message', 'nov5-hangup', 'nov3-urgent', 'nov3-hangup'])
  })
})

describe('cursor', () => {
  const before = ['a', 'b', 'c', 'd']
  it('stays on the same call when rows are added or reordered', () => {
    expect(resolveCursor(['new', 'c', 'a', 'b', 'd'], 'c', before)).toBe('c')
  })
  it('moves to the former neighbour when its row is gone: the next one first, then the previous', () => {
    expect(resolveCursor(['a', 'c', 'd'], 'b', before)).toBe('c')
    expect(resolveCursor(['a', 'b', 'c'], 'd', before)).toBe('c')
    expect(resolveCursor(['a', 'd'], 'b', before)).toBe('d')
  })
  it('starts on the first row and is empty for an empty list', () => {
    expect(resolveCursor(['a', 'b'], null, [])).toBe('a')
    expect(resolveCursor(['x', 'y'], 'gone', before)).toBe('x')
    expect(resolveCursor([], 'a', before)).toBeNull()
  })
})
