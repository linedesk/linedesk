import { describe, expect, test } from 'vitest'
import { type InsightBucket, foldInsights, periodSpans, spanDays } from './insights.ts'

describe('periodSpans', () => {
  const today = '2026-11-13'
  test('the last 7 and 30 days, compared with the same number of days before', () => {
    expect(periodSpans('7d', today, null)).toEqual({
      span: { from: '2026-11-07', to: today },
      compareWith: { from: '2026-10-31', to: '2026-11-06' },
    })
    const { span, compareWith } = periodSpans('30d', today, null)
    expect(spanDays(span)).toBe(30)
    expect(compareWith).toEqual({ from: '2026-09-15', to: '2026-10-14' })
  })
  test('this month so far, compared with the same days of last month', () => {
    expect(periodSpans('month', today, null)).toEqual({
      span: { from: '2026-11-01', to: today },
      compareWith: { from: '2026-10-01', to: '2026-10-13' },
    })
    // March 31: February has no 31st, so the comparison ends on its last day.
    expect(periodSpans('month', '2026-03-31', null).compareWith).toEqual({ from: '2026-02-01', to: '2026-02-28' })
  })
  test('last month, compared with the month before it', () => {
    expect(periodSpans('lastMonth', today, null)).toEqual({
      span: { from: '2026-10-01', to: '2026-10-31' },
      compareWith: { from: '2026-09-01', to: '2026-09-30' },
    })
    expect(periodSpans('lastMonth', '2026-01-05', null).span).toEqual({ from: '2025-12-01', to: '2025-12-31' })
  })
  test('the last 12 months start on the first of a month, compared with the year before', () => {
    expect(periodSpans('12m', today, null)).toEqual({
      span: { from: '2025-12-01', to: today },
      compareWith: { from: '2024-12-01', to: '2025-11-13' },
    })
  })
  test('all time starts at the first call and compares with nothing', () => {
    expect(periodSpans('all', today, '2025-09-08')).toEqual({
      span: { from: '2025-09-08', to: today },
      compareWith: null,
    })
    expect(periodSpans('all', today, null).span).toEqual({ from: today, to: today })
  })
  test('the older `days` input still works', () => {
    expect(spanDays(periodSpans({ days: 90 }, today, null).span)).toBe(90)
  })
})

const bucket = (b: Partial<InsightBucket>): InsightBucket => ({
  current: true,
  day: '2026-11-13',
  hour: 9,
  calls: 0,
  answered: 0,
  missed: 0,
  urgent: 0,
  booked: 0,
  messages: 0,
  transferred: 0,
  other: 0,
  spam: 0,
  seconds: 0,
  after_hours: 0,
  urgent_after_hours: 0,
  ...b,
})

describe('foldInsights', () => {
  test('totals, one row per day, busy times without spam, and the period before', () => {
    const data = foldInsights(
      [
        bucket({ day: '2026-11-11', hour: 9, calls: 3, answered: 2, booked: 1, other: 1, spam: 1, seconds: 300 }), // a Wednesday
        bucket({ day: '2026-11-13', hour: 14, calls: 1, missed: 1, seconds: 30 }),
        bucket({ current: false, day: '2026-11-01', calls: 5, answered: 5 }),
      ],
      {
        period: '7d',
        today: '2026-11-13',
        span: { from: '2026-11-07', to: '2026-11-13' },
        compareWith: { from: '2026-10-31', to: '2026-11-06' },
        firstCall: '2026-10-01',
        timeZone: 'America/New_York',
        hoursOn: false,
        jobValueCents: null,
      },
    )
    expect(data.current).toMatchObject({
      calls: 4,
      answered: 2,
      missed: 1,
      booked: 1,
      other: 1,
      spam: 1,
      minutes: 6,
      afterHours: null,
    })
    expect(data.previous.answered).toBe(5)
    expect(data.days).toBe(7)
    expect(data.daily.map(d => d.date)).toEqual([
      '2026-11-07',
      '2026-11-08',
      '2026-11-09',
      '2026-11-10',
      '2026-11-11',
      '2026-11-12',
      '2026-11-13',
    ])
    expect(data.daily[4]).toMatchObject({ calls: 3, booked: 1, minutes: 5 })
    expect(data.byWeekdayHour[3]![9]).toBe(2) // spam left out
    expect(data.byHour[14]).toBe(1)
    expect(data.byWeekday[5]).toBe(1)
  })
})

describe('custom ranges', () => {
  test('compared with the same number of days before; never past today', () => {
    expect(periodSpans({ from: '2026-10-01', to: '2026-10-10' }, '2026-11-13', null)).toEqual({
      span: { from: '2026-10-01', to: '2026-10-10' },
      compareWith: { from: '2026-09-21', to: '2026-09-30' },
    })
    expect(periodSpans({ from: '2026-11-10', to: '2026-12-31' }, '2026-11-13', null).span).toEqual({
      from: '2026-11-10',
      to: '2026-11-13',
    })
    expect(periodSpans({ from: '2026-12-01', to: '2026-12-31' }, '2026-11-13', null).span).toEqual({
      from: '2026-11-13',
      to: '2026-11-13',
    })
  })
})
