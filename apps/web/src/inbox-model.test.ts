import type { Call, TranscriptSegment } from '@linedesk/db/types'
import { describe, expect, it } from 'vitest'
import { whenLabel } from './time.ts'
import {
  answeredByLabel,
  callStatus,
  countsFor,
  groupRepeats,
  transferText,
  listFor,
  resolveCursor,
  statusLabel,
  tabOf,
} from './inbox-model.ts'

const now = new Date('2026-11-10T12:00:00Z')
const call = (over: Partial<Call>) =>
  ({
    id: 'c',
    status: 'completed',
    outcome: 'answered',
    urgency: 'normal',
    inbox_state: 'open',
    reminder_at: null,
    reminder_label: null,
    deleted_at: null,
    started_at: '2026-11-10 10:00:00+00',
    from_number: '+15035550100',
    direction: 'in',
    action_items: [],
    ...over,
  }) as Call

describe('inbox views', () => {
  it('puts calls where a person has to act in Needs you', () => {
    for (const c of [
      call({ status: 'live' }),
      call({ urgency: 'urgent', outcome: 'booked' }),
      call({ outcome: 'callback' }),
      call({ outcome: 'message' }),
      call({ outcome: 'hangup' }),
    ]) {
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
      call({
        id: 'earlier-from-3',
        outcome: 'answered',
        inbox_state: 'done',
        from_number: '+3',
        started_at: '2026-11-02 09:00:00+00',
      }),
    ]
    expect(listFor(calls, 'you', now).map(c => c.id)).toEqual([
      'live',
      'urgent',
      'new-callback',
      'known-callback',
      'message',
      'hangup',
    ])
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

const agentSaid = { speaker: 'agent', text: 'Brightwater, this is Maya.', at_ms: 500 } as TranscriptSegment
const systemLine = { speaker: 'system', text: 'Missed', at_ms: 0 } as TranscriptSegment

describe('call status', () => {
  it('tells a missed call (nobody answered) from a hang-up after the greeting', () => {
    expect(callStatus(call({ outcome: 'hangup' }), [systemLine])).toBe('missed')
    expect(callStatus(call({ outcome: 'hangup' }), [agentSaid])).toBe('hungUp')
    expect(callStatus(call({ outcome: 'message' }), [agentSaid])).toBe('answered')
    expect(callStatus(call({ status: 'live', outcome: null }), [])).toBe('live')
  })
  it('says the same in the call header', () => {
    expect(answeredByLabel(call({ outcome: 'hangup' }), [systemLine], 'Maya')).toBe('Missed')
    expect(answeredByLabel(call({ outcome: 'hangup' }), [agentSaid], 'Maya')).toBe('Answered by Maya, caller hung up')
    expect(answeredByLabel(call({ outcome: 'callback' }), [agentSaid], 'Maya')).toBe('Answered by Maya')
  })
})

describe('repeat calls', () => {
  const at = (hour: number) => `2026-11-10 ${String(hour).padStart(2, '0')}:00:00+00`
  it('folds hang-ups from one number into one row, the newest', () => {
    const calls = [1, 2, 3, 4].map(h => call({ id: `h${h}`, outcome: 'hangup', started_at: at(h) }))
    const { list, groups } = groupRepeats(listFor(calls, 'you', now))
    expect(list.map(c => c.id)).toEqual(['h4'])
    expect(groups.get('h4')?.map(c => c.id)).toEqual(['h4', 'h3', 'h2', 'h1'])
    expect(countsFor(calls, now).you).toBe(1)
  })
  it('folds hang-ups into the real call from the same number, and keeps other numbers and real calls apart', () => {
    const calls = [
      call({ id: 'leak', outcome: 'callback', started_at: at(8) }),
      call({ id: 'hang', outcome: 'hangup', started_at: at(9) }),
      call({ id: 'quote', outcome: 'message', started_at: at(7) }),
      call({ id: 'other', outcome: 'hangup', from_number: '+15035550199', started_at: at(6) }),
      call({ id: 'live', status: 'live', outcome: null, started_at: at(10) }),
    ]
    const { list, groups } = groupRepeats(listFor(calls, 'you', now))
    expect(list.map(c => c.id)).toEqual(['live', 'leak', 'quote', 'other'])
    expect(groups.get('leak')?.map(c => c.id)).toEqual(['leak', 'hang'])
    expect(groups.size).toBe(1)
  })
})

describe('status column', () => {
  const label = (over: Partial<Call>, tab: 'you' | 'ai' = 'you') => statusLabel(call(over), tab, 'Maya', now)
  it('shows what matters most', () => {
    expect(
      label({ outcome: 'callback', reminder_at: '2026-11-10T13:00:00.000Z', reminder_label: 'Later today' }),
    ).toEqual({ text: whenLabel(new Date('2026-11-10T13:00:00.000Z'), now), tone: 'neutral' }) // the time, not the label it was set with
    expect(label({ outcome: 'callback', urgency: 'urgent' })).toEqual({ text: 'Urgent callback', tone: 'danger' })
    expect(label({ outcome: 'hangup' })).toEqual({ text: 'Missed', tone: 'danger' }) // nobody answered: no assistant turn
    expect(statusLabel(call({ outcome: 'hangup' }), 'you', 'Maya', now, [agentSaid])).toEqual({
      text: 'Hung up',
      tone: 'quiet',
    })
    expect(label({ outcome: 'booked' }, 'ai')).toEqual({ text: 'Resolved by Maya', tone: 'quiet' }) // no booking UI in v1
    expect(label({ outcome: 'spam' })).toEqual({ text: 'Blocked', tone: 'neutral' })
    expect(label({ outcome: 'callback', action_items: [{ text: 'Call back' }] })).toEqual({
      text: 'Call back',
      tone: 'next',
    })
    expect(label({ outcome: 'answered' }, 'ai')).toEqual({ text: 'Resolved by Maya', tone: 'quiet' })
  })
  it('drops the reminder label once the reminder has passed', () => {
    expect(
      label({ outcome: 'callback', reminder_at: '2026-11-10 11:00:00+00', reminder_label: 'Later today' }).text,
    ).toBe('Follow-up')
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
    expect(listFor(calls, 'you', now).map(c => c.id)).toEqual([
      'nov5-message',
      'nov5-hangup',
      'nov3-urgent',
      'nov3-hangup',
    ])
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

describe('reminders view', () => {
  it('lists reminders by when they come back, soonest first', () => {
    const calls = [
      call({
        id: 'next-week',
        outcome: 'callback',
        reminder_at: '2026-11-16T16:00:00.000Z',
        started_at: '2026-11-10 11:00:00+00',
      }),
      call({
        id: 'later-today',
        outcome: 'message',
        reminder_at: '2026-11-10T15:00:00.000Z',
        started_at: '2026-11-03 09:00:00+00',
      }),
      call({
        id: 'tomorrow',
        outcome: 'booked',
        reminder_at: '2026-11-11T16:00:00.000Z',
        started_at: '2026-11-09 09:00:00+00',
      }),
      call({ id: 'passed', outcome: 'callback', reminder_at: '2026-11-10T09:00:00.000Z' }),
    ]
    expect(listFor(calls, 'reminders', now).map(c => c.id)).toEqual(['later-today', 'tomorrow', 'next-week'])
  })
})

describe('assigned to me', () => {
  it('lists the open calls assigned to the signed-in member, in any view but done and spam', () => {
    const calls = [
      call({ id: 'mine-needs-you', outcome: 'callback', assignee_id: 'u1' }),
      call({ id: 'mine-handled', assignee_id: 'u1' }),
      call({ id: 'mine-done', inbox_state: 'done', assignee_id: 'u1' }),
      call({ id: 'mine-spam', outcome: 'spam', assignee_id: 'u1' }),
      call({ id: 'theirs', outcome: 'callback', assignee_id: 'u2' }),
      call({ id: 'nobody', outcome: 'callback' }),
    ]
    expect(listFor(calls, 'mine', now, 'u1').map(c => c.id).sort()).toEqual(['mine-handled', 'mine-needs-you'])
    expect(countsFor(calls, now, 'u1').mine).toBe(2)
    expect(listFor(calls, 'mine', now, null)).toEqual([])
    // The call keeps its own view too: assigning does not move it.
    expect(tabOf(calls[0]!, now)).toBe('you')
  })
})

describe('needs review', () => {
  it('lists the calls whose evaluation needs a person, in whatever view they are, newest first, without deleted ones', () => {
    const calls = [
      call({ id: 'low-done', inbox_state: 'done', started_at: '2026-11-10 09:00:00+00' }),
      call({ id: 'low-open', outcome: 'callback', started_at: '2026-11-10 11:00:00+00' }),
      call({ id: 'low-deleted', deleted_at: '2026-11-10 11:30:00+00' }),
      call({ id: 'fine' }),
    ]
    const review = new Set(['low-done', 'low-open', 'low-deleted'])
    expect(listFor(calls, 'review', now, null, review).map(c => c.id)).toEqual(['low-open', 'low-done'])
    expect(countsFor(calls, now, null, review).review).toBe(2)
    expect(listFor(calls, 'review', now, null)).toEqual([]) // members get no evaluations: nothing to review
    // A call keeps its own view: being reviewed does not move it.
    expect(tabOf(calls[1]!, now)).toBe('you')
  })
})

describe('transferText', () => {
  it('says how the transfer went, and nothing without one', () => {
    expect(transferText({ transfer_to: '+15035550199', transfer_result: 'connected' })).toBe('Transferred to +1 503 555 0199')
    expect(transferText({ transfer_to: '+15035550199', transfer_result: 'not_answered' })).toBe('Transfer not answered')
    expect(transferText({ transfer_to: '+15035550199', transfer_result: 'declined' })).toBe('Transfer declined by +1 503 555 0199')
    expect(transferText({ transfer_to: null, transfer_result: null })).toBeNull()
  })
})
