import { expect, test } from 'vitest'
import { bookingSetUp } from './appointmentsInUse.ts'

const connected = { id: 'c1', status: 'connected' as const }
const calendar = { connection_id: 'c1', enabled: true, duration_min: null }

test('booking is set up with a calendar that is on and a type that is on', () => {
  expect(bookingSetUp([connected], [calendar], [{ enabled: true }])).toBe(true)
  expect(bookingSetUp([connected], [calendar], [])).toBe(false)
  expect(bookingSetUp([connected], [calendar], [{ enabled: false }])).toBe(false)
  expect(bookingSetUp([connected], [], [{ enabled: true }])).toBe(false)
  expect(bookingSetUp([], [], [])).toBe(false)
})

test('not with a calendar that is off or an account that needs connecting again', () => {
  expect(bookingSetUp([connected], [{ ...calendar, enabled: false }], [{ enabled: true }])).toBe(false)
  expect(bookingSetUp([{ id: 'c1', status: 'needs_reconnect' as const }], [calendar], [{ enabled: true }])).toBe(false)
})

test("a scheduling tool's event type needs no type of its own", () => {
  expect(bookingSetUp([connected], [{ ...calendar, duration_min: 30 }], [])).toBe(true)
})
