import type { InsightDay } from '@linedesk/actions'
import { describe, expect, test } from 'vitest'
import {
  busiestTime,
  change,
  columns,
  compareLabel,
  groupingFor,
  spanLabel,
  summarySentence,
  totalsTable,
} from './insightsModel.ts'

const day = (date: string, answered: number, missed = 0): InsightDay => ({
  date,
  calls: answered + missed,
  answered,
  missed,
  urgent: 0,
  booked: 0,
  messages: 0,
  transferred: 0,
  other: answered,
  spam: 0,
  minutes: 0,
  afterHours: null,
  urgentAfterHours: null,
})

describe('change', () => {
  test('counts on small numbers, a percentage only when both periods have at least 20', () => {
    expect(change(3, 2)).toBe('+1')
    expect(change(2, 3)).toBe('−1')
    expect(change(4, 4)).toBe('Same')
    expect(change(5, 0)).toBe('+5')
    expect(change(44, 40)).toBe('+4 (+10%)')
    expect(change(30, 40)).toBe('−10 (−25%)')
  })
})

describe('labels', () => {
  test('the span and what it is compared with', () => {
    expect(spanLabel('2026-10-15', '2026-11-13')).toBe('Oct 15 – Nov 13, 2026')
    expect(spanLabel('2025-12-01', '2026-11-13')).toBe('Dec 1, 2025 – Nov 13, 2026')
    expect(compareLabel({ period: '30d', days: 30, compareWith: { from: '2026-09-15', to: '2026-10-14' } })).toBe(
      'prior 30 days',
    )
    expect(compareLabel({ period: 'month', days: 13, compareWith: { from: '2026-10-01', to: '2026-10-13' } })).toBe(
      'Oct 1–13',
    )
    expect(compareLabel({ period: 'lastMonth', days: 31, compareWith: { from: '2026-09-01', to: '2026-09-30' } })).toBe(
      'September',
    )
    expect(compareLabel({ period: 'all', days: 400, compareWith: null })).toBeNull()
  })
  test('the sentence follows the period', () => {
    const c = { ...day('2026-11-13', 34), booked: 9, urgent: 2, urgentAfterHours: 0 }
    expect(summarySentence('Maya', { period: '7d', days: 7 }, c)).toBe(
      'In the last 7 days Maya answered 34 calls, booked 9 jobs and flagged 2 urgent calls.',
    )
    expect(summarySentence('Maya', { period: 'all', days: 400 }, c)).toMatch(/^Since your first call Maya/)
    expect(summarySentence('Maya', { period: 'month', days: 13 }, { ...c, calls: 0 })).toBe('No calls this month.')
  })
})

describe('columns', () => {
  test('grouping by length', () => {
    expect(groupingFor(30)).toBe('day')
    expect(groupingFor(62)).toBe('week')
    expect(groupingFor(348)).toBe('month')
  })
  test('weeks start on Monday; the week that goes on past today is marked', () => {
    // Nov 5 2026 is a Thursday, Nov 13 a Friday.
    const days = ['2026-11-05', '2026-11-06', '2026-11-07', '2026-11-08', '2026-11-09', '2026-11-13'].map(d =>
      day(d, 1, 1),
    )
    const cols = columns(days, 'answered', 'week', '2026-11-13')
    expect(cols.map(c => [c.key, c.value, c.missed, c.partial])).toEqual([
      ['2026-11-02', 4, 4, false],
      ['2026-11-09', 2, 2, true],
    ])
  })
  test('months', () => {
    const cols = columns([day('2026-10-31', 2), day('2026-11-01', 3)], 'answered', 'month', '2026-11-13')
    expect(cols.map(c => [c.label, c.value, c.partial])).toEqual([
      ['Oct 2026', 2, false],
      ['Nov 2026', 3, true],
    ])
  })
})

describe('busiestTime', () => {
  test('the weekday and hour with the most calls', () => {
    const grid = Array.from({ length: 7 }, () => Array(24).fill(0))
    grid[2]![9] = 5
    grid[4]![11] = 3
    expect(busiestTime(grid)).toBe('Tuesdays, 9–10 am')
    grid[2]![9] = 0
    expect(busiestTime(grid)).toBe('Thursdays, 11 am–12 pm')
    expect(busiestTime(Array.from({ length: 7 }, () => Array(24).fill(0)))).toBeNull()
  })
})

test('the totals table leaves out after hours without business hours and adds the value when set', () => {
  const t = totalsTable({
    current: { afterHours: null },
    jobValueCents: 35000,
    daily: [{ ...day('2026-11-13', 2), booked: 2 }],
  } as never)
  expect(t.header).not.toContain('After hours')
  expect(t.header.at(-1)).toBe('Booked value (USD)')
  expect(t.rows[0]!.at(-1)).toBe(700)
})
