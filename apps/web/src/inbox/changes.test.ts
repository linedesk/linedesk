import type { Call } from '@callfront/db/types'
import { describe, expect, it } from 'vitest'
import { type Change, clearReminderChange, deleteChange, doneChange, isNoOp, notDoneChange, preview, remindChange, unreadChange } from './changes.ts'

const call = (over: Partial<Call> = {}) => ({
  id: 'c1', status: 'completed', inbox_state: 'open', unread: true, reminder_at: null, reminder_label: null, deleted_at: null, ...over,
}) as Call
const option = { label: 'Tomorrow morning', icon: 'calendar' as const, at: new Date('2026-11-11T16:00:00.000Z'), hint: 'Tomorrow 8:00 AM' }
const state = (c: Call) => ({ inbox_state: c.inbox_state, unread: c.unread, deleted_at: c.deleted_at, reminder_label: c.reminder_label, reminder_at: c.reminder_at && new Date(c.reminder_at).toISOString() })
/** Apply the change and then its inverse, as E followed by Z does. */
const roundTrip = (c: Call, change: Change) => state(preview(preview(c, change.steps), change.inverse))

describe('undo is the inverse action', () => {
  it('restores the call after done, not done, read, unread and delete', () => {
    const done = call({ inbox_state: 'done', unread: false })
    expect(roundTrip(call(), doneChange(call()))).toEqual(state(call()))
    expect(roundTrip(call({ unread: false }), doneChange(call({ unread: false })))).toEqual(state(call({ unread: false })))
    expect(roundTrip(done, notDoneChange(done))).toEqual(state(done))
    expect(roundTrip(call(), unreadChange(call()))).toEqual(state(call()))
    expect(roundTrip(call({ unread: false }), unreadChange(call({ unread: false })))).toEqual(state(call({ unread: false })))
    expect(roundTrip(call(), deleteChange(call()))).toEqual(state(call()))
  })
  it('restores the reminder that was there before', () => {
    const reminded = call({ reminder_at: '2026-11-12 16:00:00+00', reminder_label: 'In two days' })
    expect(roundTrip(call(), remindChange(call(), option))).toEqual(state(call()))
    expect(roundTrip(reminded, remindChange(reminded, option))).toEqual(state(reminded))
    expect(roundTrip(reminded, clearReminderChange(reminded))).toEqual(state(reminded))
  })
  it('reopens a done call when it gets a reminder, and closes it again on undo', () => {
    const done = call({ inbox_state: 'done', unread: false })
    const change = remindChange(done, option)
    expect(preview(done, change.steps)).toMatchObject({ inbox_state: 'open', reminder_label: 'Tomorrow morning' })
    expect(roundTrip(done, change)).toEqual(state(done))
  })
})

describe('no-op changes', () => {
  it('sees that marking a done call done changes nothing', () => {
    expect(isNoOp(call({ inbox_state: 'done', unread: false }), doneChange(call()).steps)).toBe(true)
    expect(isNoOp(call(), doneChange(call()).steps)).toBe(false)
    expect(isNoOp(call({ inbox_state: 'done' }), doneChange(call()).steps)).toBe(false) // still unread
  })
})
