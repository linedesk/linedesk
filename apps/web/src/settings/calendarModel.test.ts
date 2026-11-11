import { expect, test } from 'vitest'
import { calendarsOf, connectResult, durationLabel, requiredLabel, typeFields } from './calendarModel.ts'

test('the OAuth callback result in the hash becomes a toast', () => {
  expect(connectResult('#assistant/as_1/calendar?calendar=connected')).toEqual({ ok: true, text: 'Calendar connected. Pick the calendars the assistant books into.' })
  expect(connectResult('#assistant/as_1/calendar?calendar=connected&connection=calc_1')).toMatchObject({ ok: true, connectionId: 'calc_1' })
  expect(connectResult('#assistant/as_1/calendar?calendar=error&reason=Access%20was%20not%20granted.')).toEqual({ ok: false, text: 'Access was not granted.' })
  expect(connectResult('#assistant/as_1/calendar')).toBeNull()
  expect(connectResult('#assistant/as_1/calendar?other=1')).toBeNull()
})

test('durations and required details read as the owner says them', () => {
  expect(durationLabel(30)).toBe('30 min')
  expect(durationLabel(60)).toBe('1 h')
  expect(durationLabel(90)).toBe('1 h 30 min')
  expect(requiredLabel({ required_fields: [], name_required: true })).toBe('Asks for name')
  expect(requiredLabel({ required_fields: ['address', 'email'], name_required: true })).toBe(
    'Asks for name, email, address',
  )
  expect(requiredLabel({ required_fields: [], name_required: false })).toBe('Asks only for the reason')
  expect(typeFields({ required_fields: ['address'], name_required: false })).toEqual(['address'])
})

test("an assistant's calendars: the default first, then in the order they were added", () => {
  const row = (id: string, assistant_id: string, created_at: string, is_default = false) => ({ id, assistant_id, created_at, is_default }) as never
  const rows = [row('b', 'as_1', '2026-01-02'), row('c', 'as_2', '2026-01-01'), row('a', 'as_1', '2026-01-01'), row('d', 'as_1', '2026-01-03', true)]
  expect(calendarsOf(rows, 'as_1').map(c => (c as { id: string }).id)).toEqual(['d', 'a', 'b'])
})
