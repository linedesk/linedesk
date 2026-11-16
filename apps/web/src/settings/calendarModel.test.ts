import { expect, test } from 'vitest'
import {
  accountMark,
  calendarsOf,
  connectMark,
  connectResult,
  durationLabel,
  pickChanges,
  requiredLabel,
  rulesLabel,
  toolTypeRows,
  typeFields,
} from './calendarModel.ts'

test('the OAuth callback result in the hash becomes a toast', () => {
  expect(connectResult('#assistant/as_1/calendar?calendar=connected')).toEqual({
    ok: true,
    text: 'Calendar connected. Pick the calendars the assistant books into.',
  })
  expect(connectResult('#assistant/as_1/calendar?calendar=connected&connection=calc_1')).toMatchObject({
    ok: true,
    connectionId: 'calc_1',
  })
  expect(connectResult('#assistant/as_1/calendar?calendar=error&reason=Access%20was%20not%20granted.')).toEqual({
    ok: false,
    text: 'Access was not granted.',
  })
  expect(connectResult('#assistant/as_1/calendar')).toBeNull()
  expect(connectResult('#assistant/as_1/calendar?other=1')).toBeNull()
})

test('durations and required details read as the owner says them', () => {
  expect(durationLabel(30)).toBe('30m')
  expect(durationLabel(60)).toBe('1h')
  expect(durationLabel(90)).toBe('1h 30m')
  expect(requiredLabel({ required_fields: [], name_required: true })).toBe('Asks for name')
  expect(requiredLabel({ required_fields: ['address', 'email'], name_required: true })).toBe(
    'Asks for name, email, address',
  )
  expect(requiredLabel({ required_fields: [], name_required: false })).toBe('Asks only for the reason')
  expect(typeFields({ required_fields: ['address'], name_required: false })).toEqual(['address'])
})

test('booking rules read short, only what differs from the defaults', () => {
  const t = (
    buffer_before_min: number,
    buffer_after_min: number,
    book_when: 'business_hours' | 'outside_business_hours' | 'any_time' = 'business_hours',
  ) => ({ buffer_before_min, buffer_after_min, book_when })
  expect(rulesLabel(t(0, 0))).toBe('')
  expect(rulesLabel(t(15, 15))).toBe('15 min buffer')
  expect(rulesLabel(t(15, 0, 'outside_business_hours'))).toBe('15 min before · Outside business hours')
  expect(rulesLabel(t(0, 10, 'any_time'))).toBe('10 min after · Any time')
})

test("an assistant's calendars: the default first, then in the order they were added", () => {
  const row = (id: string, assistant_id: string, created_at: string, is_default = false) =>
    ({ id, assistant_id, created_at, is_default }) as never
  const rows = [
    row('b', 'as_1', '2026-01-02'),
    row('c', 'as_2', '2026-01-01'),
    row('a', 'as_1', '2026-01-01'),
    row('d', 'as_1', '2026-01-03', true),
  ]
  expect(calendarsOf(rows, 'as_1').map(c => (c as { id: string }).id)).toEqual(['d', 'a', 'b'])
})

test('a calendar account shows its brand; a CalDAV login at Apple shows iCloud, other servers a neutral calendar', () => {
  const account = (provider: 'google' | 'caldav' | 'calcom' | 'calendly', account_email: string) => ({
    provider,
    account_email,
  })
  expect(accountMark(account('google', 'mike@brightwater.example'))).toBe('google')
  expect(accountMark(account('calcom', 'mike@brightwater.example'))).toBe('calcom')
  expect(accountMark(account('calendly', 'mike@brightwater.example'))).toBe('calendly')
  expect(accountMark(account('caldav', 'mike@icloud.com'))).toBe('icloud')
  expect(accountMark(account('caldav', 'Mike@Me.com'))).toBe('icloud')
  expect(accountMark(account('caldav', 'mike@caldav.icloud.com'))).toBe('icloud')
  expect(accountMark(account('caldav', 'mike@caldav.fastmail.com'))).toBe('caldav')
  expect(connectMark('caldav')).toBe('icloud')
  expect(connectMark('calendly')).toBe('calendly')
})

test('saving the event-type picker adds the newly ticked types and removes the unticked ones', () => {
  const current = [
    { id: 'acal_1', external_id: 'et_1' },
    { id: 'acal_2', external_id: 'et_2' },
  ]
  expect(pickChanges(current, new Set(['et_2', 'et_3', 'et_4']))).toEqual({ add: ['et_3', 'et_4'], remove: ['acal_1'] })
  expect(pickChanges(current, new Set(['et_1', 'et_2']))).toEqual({ add: [], remove: [] })
  expect(pickChanges([], new Set(['et_9']))).toEqual({ add: ['et_9'], remove: [] })
  // A row the list does not show (a team type the account no longer reaches) is never removed.
  expect(pickChanges(current, new Set(['et_2']), new Set(['et_2', 'et_3']))).toEqual({ add: [], remove: [] })
})

test("Appointment types show all of a tool's event types, the added ones with their row; one gone from the tool stays", () => {
  const row = (id: string, external_id: string) => ({ id, external_id }) as never
  const added = [row('acal_2', 'et_2'), row('acal_9', 'et_9')]
  expect(toolTypeRows(added, [{ id: 'et_1' }, { id: 'et_2' }])).toEqual([
    { listed: { id: 'et_1' } },
    { added: added[0], listed: { id: 'et_2' } },
    { added: added[1] },
  ])
  // Before the tool's list loads: the added ones.
  expect(toolTypeRows(added, null)).toEqual([{ added: added[0] }, { added: added[1] }])
})
