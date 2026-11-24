import { expect, test } from 'vitest'
import { bookingDisplay } from './BookingCard.tsx'

test('a booking shows its weekday, day of the month and time range', () => {
  const start = new Date(2030, 0, 8, 9, 0)
  const end = new Date(2030, 0, 8, 10, 30)
  expect(bookingDisplay({ start_at: start.toISOString(), end_at: end.toISOString() })).toEqual({ dow: 'TUE', day: '8', time: expect.stringMatching(/^9:00\s?[–-]\s?10:30\sAM$/) })
})
