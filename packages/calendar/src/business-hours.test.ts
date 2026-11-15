import { describe, expect, it } from 'vitest'
import { businessHoursContext, timeLabel, weeklyLabel } from './business-hours.ts'

const TZ = 'America/Los_Angeles'
const weekdays = [1, 2, 3, 4, 5].map(weekday => ({ weekday, start_time: '07:00', end_time: '18:00' }))
const saturday = { weekday: 6, start_time: '08:00:00', end_time: '12:00:00' }
// 2026-11-10 is a Tuesday. 17:00 UTC = 9:00 AM in Portland.
const at = (iso: string) => Date.parse(iso)

describe('business hours for the assistant', () => {
  it('no hours: nothing to say', () => {
    expect(businessHoursContext([], TZ, at('2026-11-10T17:00:00Z'))).toBeNull()
  })

  it('open now, until closing time', () => {
    const ctx = businessHoursContext([...weekdays, saturday], TZ, at('2026-11-10T17:00:00Z'))!
    expect(ctx.openNow).toBe(true)
    expect(ctx.nextChangeAt).toBe('2026-11-11T02:00:00.000Z') // 6 PM Pacific
    expect(ctx.summary).toBe(
      'Business hours: Monday to Friday 7:00 AM–6:00 PM; Saturday 8:00 AM–12:00 PM. Open now, until 6:00 PM.',
    )
  })

  it('in the evening: closed, opens tomorrow morning', () => {
    const ctx = businessHoursContext(weekdays, TZ, at('2026-11-11T04:00:00Z'))! // Tuesday 8 PM
    expect(ctx.openNow).toBe(false)
    expect(ctx.nextChangeAt).toBe('2026-11-11T15:00:00.000Z')
    expect(ctx.summary).toMatch(/Closed now; opens tomorrow at 7:00 AM\.$/)
  })

  it('early morning: opens today; on Friday night: opens Monday', () => {
    expect(businessHoursContext(weekdays, TZ, at('2026-11-10T13:00:00Z'))!.summary).toMatch(/opens today at 7:00 AM\.$/)
    expect(businessHoursContext(weekdays, TZ, at('2026-11-14T05:00:00Z'))!.summary).toMatch(
      /opens Monday at 7:00 AM\.$/,
    ) // Friday 9 PM
  })

  it('labels', () => {
    expect(timeLabel('00:00')).toBe('midnight')
    expect(timeLabel('12:30')).toBe('12:30 PM')
    expect(timeLabel('24:00')).toBe('midnight')
    expect(
      weeklyLabel([
        { weekday: 1, start: '09:00', end: '12:00' },
        { weekday: 1, start: '13:00', end: '17:00' },
      ]),
    ).toBe('Monday 9:00 AM–12:00 PM and 1:00 PM–5:00 PM')
  })
})
