import type { InsightDay } from '@linedesk/actions'
import { jobValueCurrencies } from '@linedesk/actions'
import { describe, expect, test } from 'vitest'
import {
  busiestTime,
  currencyOptions,
  topCurrencies,
  currencyLabel,
  formatMoney,
  moneyText,
  parseMoney,
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
      'In the last 7 days Maya answered 34 calls, booked 9 appointments, and flagged 2 urgent calls.',
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
    // Hour ranges as Intl writes them in the active language (thin spaces around the dash in English).
    expect(busiestTime(grid)).toBe('Tuesdays, 9\u2009–\u200910\u202fAM')
    grid[2]![9] = 0
    expect(busiestTime(grid)).toBe('Thursdays, 11\u202fAM\u2009–\u200912\u202fPM')
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

test('money is shown in the appointment value currency, in whole units', () => {
  expect(formatMoney(125_000)).toBe('$1,250')
  expect(formatMoney(35_000, 'EUR')).toBe('€350')
  expect(formatMoney(9_000, 'GBP')).toBe('£90')
  expect(formatMoney(35_000, 'CHF')).toBe('CHF\u00a0350')
  expect(parseMoney('€1,250.50')).toBe(125_050)
  expect(parseMoney('£90')).toBe(9_000)
})

test('JPY has no minor units: ¥5,000 is typed as 5000, stored as 5000 and shown without decimals', () => {
  expect(parseMoney('5000', 'JPY')).toBe(5_000)
  expect(parseMoney('¥5,000', 'JPY')).toBe(5_000)
  expect(parseMoney('5000.5', 'JPY')).toBeUndefined()
  expect(formatMoney(5_000, 'JPY')).toBe('¥5,000')
  expect(moneyText(5_000, 'JPY')).toBe('5000')
  // Two-decimal currencies stay in cents.
  expect(parseMoney('900', 'SEK')).toBe(90_000)
  expect(parseMoney('SEK 1,250.50', 'SEK')).toBe(125_050)
  expect(formatMoney(90_000, 'SEK')).toBe('SEK\u00a0900')
  expect(parseMoney('₹1,500', 'INR')).toBe(150_000)
  expect(parseMoney('R$ 90', 'BRL')).toBe(9_000)
  expect(formatMoney(150_000, 'INR')).toBe('₹1,500')
  expect(moneyText(35_050, 'USD')).toBe('350.5')
  expect(moneyText(null, 'JPY')).toBe('')
  // Text that is not a number stays not a value; empty clears it.
  for (const text of ['abc', 'kr', '12abc34', '1.2.3']) expect(parseMoney(text, 'SEK')).toBeUndefined()
  expect(parseMoney('  ', 'JPY')).toBeNull()
})

test('the typed amount stays when the currency changes: 350 is $350 in cents and ¥350 in yen', () => {
  const typed = moneyText(35_000, 'USD')
  expect(parseMoney(typed, 'JPY')).toBe(350)
  expect(parseMoney(moneyText(5_000, 'JPY'), 'USD')).toBe(500_000)
})

test('the currency menu shows each code with its symbol, the code alone where the symbol is the code', () => {
  expect(currencyLabel('USD')).toBe('USD · $')
  expect(currencyLabel('EUR')).toBe('EUR · €')
  expect(currencyLabel('GBP')).toBe('GBP · £')
  expect(currencyLabel('CAD')).toBe('CAD · CA$')
  expect(currencyLabel('AUD')).toBe('AUD · A$')
  expect(currencyLabel('CHF')).toBe('CHF')
  expect(currencyLabel('JPY')).toBe('JPY · ¥')
  expect(currencyLabel('INR')).toBe('INR · ₹')
  expect(currencyLabel('SEK')).toBe('SEK')
  expect(currencyLabel('MXN')).toBe('MXN · MX$')
  expect(currencyLabel('KRW')).toBe('KRW · ₩')
  expect(currencyLabel('CNY')).toBe('CNY · CN¥')
  expect(currencyLabel('HKD')).toBe('HKD · HK$')
  expect(currencyLabel('TWD')).toBe('TWD · NT$')
  expect(currencyLabel('ILS')).toBe('ILS · ₪')
  expect(currencyLabel('PHP')).toBe('PHP · ₱')
  expect(currencyLabel('PLN')).toBe('PLN')
  expect(currencyLabel('CLP')).toBe('CLP')
  expect(currencyOptions()[0]).toEqual({ value: 'USD', label: 'USD · $' })
})

test('the currency menu shows the common currencies first (C12), then every other one by code under a heading', () => {
  const top = currencyOptions().filter(o => !o.group).map(o => o.value)
  const rest = currencyOptions().filter(o => o.group).map(o => o.value)
  expect(top).toEqual(['USD', 'CAD', 'GBP', 'AUD'])
  expect(rest).toEqual([
    'AED',
    'ARS',
    'BRL',
    'CHF',
    'CLP',
    'CNY',
    'COP',
    'CZK',
    'DKK',
    'EGP',
    'EUR',
    'HKD',
    'HUF',
    'IDR',
    'ILS',
    'INR',
    'JPY',
    'KES',
    'KRW',
    'MXN',
    'MYR',
    'NGN',
    'NOK',
    'NZD',
    'PEN',
    'PHP',
    'PLN',
    'RON',
    'SAR',
    'SEK',
    'SGD',
    'THB',
    'TRY',
    'TWD',
    'ZAR',
  ])
  // The top ones come first and are not repeated; every offered currency is there once.
  expect(currencyOptions().map(o => o.value)).toEqual([...top, ...rest])
  expect([...currencyOptions().map(o => o.value)].sort()).toEqual([...jobValueCurrencies].sort())
  expect(new Set(rest.map(c => currencyOptions().find(o => o.value === c)?.group))).toEqual(new Set(['All currencies']))
})

test('currencies without minor units are typed and shown in whole units', () => {
  expect(parseMoney('50000', 'KRW')).toBe(50_000)
  expect(parseMoney('5000.5', 'CLP')).toBeUndefined()
  expect(formatMoney(50_000, 'KRW')).toBe('₩50,000')
  expect(parseMoney('1,250.50', 'PLN')).toBe(125_050)
})

test('the totals table names the currency of the value', () => {
  const t = totalsTable({
    current: { afterHours: null },
    jobValueCents: 35000,
    jobValueCurrency: 'EUR',
    daily: [{ ...day('2026-11-13', 2), booked: 2 }],
  } as never)
  expect(t.header.at(-1)).toBe('Booked value (EUR)')
})

test('the totals table counts a JPY value in whole yen', () => {
  const t = totalsTable({
    current: { afterHours: null },
    jobValueCents: 5000,
    jobValueCurrency: 'JPY',
    daily: [{ ...day('2026-11-13', 2), booked: 2 }],
  } as never)
  expect(t.header.at(-1)).toBe('Booked value (JPY)')
  expect(t.rows[0]!.at(-1)).toBe(10_000)
})

test("the viewer's own currency leads the menu, once (C12)", () => {
  expect(topCurrencies('EUR')).toEqual(['EUR', 'USD', 'CAD', 'GBP', 'AUD'])
  expect(topCurrencies('GBP')).toEqual(['GBP', 'USD', 'CAD', 'AUD'])
  expect(topCurrencies(null)).toEqual(['USD', 'CAD', 'GBP', 'AUD'])
  const options = currencyOptions('EUR')
  expect(options[0]).toEqual({ value: 'EUR', label: 'EUR · €' })
  expect(options.filter(o => o.value === 'EUR')).toHaveLength(1)
})
