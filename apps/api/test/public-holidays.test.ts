// Public holidays and yearly days: the holiday data (date-holidays), the days derived for the next twelve
// months, and the actions holidays.lookup, holidays.set and closedDays.set that keep them written.
import { availability_exceptions } from '@linedesk/db'
import { and, eq } from 'drizzle-orm'
import { describe, expect, test } from 'vitest'
import { db } from '../src/db.ts'
import {
  countryOfTimeZone,
  derivedDays,
  holidayDates,
  holidayList,
  todayIn,
  yearAfter,
} from '../src/public-holidays.ts'
import { act, addMember, createWorkspace } from './helpers.ts'

const calendar = (over: object = {}) => ({ on: true, country: 'US', state: null, off: [], changes: [], ...over })

describe('holiday data', () => {
  test('a year from today, public ones only, one per date, US English, observed days named so', () => {
    const days = holidayDates('US', null, '2026-11-14', yearAfter('2026-11-14'))
    expect(days[0]).toEqual({ key: 'Thanksgiving Day', date: '2026-11-26', name: 'Thanksgiving Day' })
    expect(days.at(-1)!.date <= '2027-11-13').toBe(true)
    expect(days).toContainEqual({ key: 'Labor Day', date: '2027-09-06', name: 'Labor Day' })
    expect(days).toContainEqual({ key: 'Independence Day', date: '2027-07-05', name: 'Independence Day (observed)' })
    expect(days.some(d => /Valentine/.test(d.name))).toBe(false)
    expect(new Set(days.map(d => d.date)).size).toBe(days.length)
  })

  test('the list has each holiday once; a state adds its own', () => {
    const us = holidayList('US', null, '2026-11-14')
    expect(us.filter(h => h.key === 'Independence Day')).toHaveLength(1)
    expect(holidayList('US', 'CA', '2026-11-14').some(h => h.key === 'César Chávez Day')).toBe(true)
    expect(holidayList('DE', null, '2027-01-01').some(h => h.date === '2027-01-06')).toBe(false)
    expect(holidayList('DE', 'BY', '2027-01-01').some(h => h.date === '2027-01-06')).toBe(true)
  })

  test('the time zone suggests the country', () => {
    expect(countryOfTimeZone('Europe/Berlin')).toBe('DE')
    expect(countryOfTimeZone('America/Chicago')).toBe('US')
    expect(countryOfTimeZone('Not/AZone')).toBeNull()
  })
})

describe('derived days', () => {
  const today = '2026-11-14'
  test('holidays less the ones open every year; changes for one date; own days win', () => {
    const days = derivedDays(
      calendar({
        off: ['Columbus Day'],
        changes: [
          { date: '2026-11-26', name: 'Thanksgiving Day', open: true, start: null, end: null },
          { date: '2026-12-25', name: 'Christmas Day', open: false, start: '08:00', end: '12:00' },
        ],
      }),
      [{ date: '2027-01-01', name: 'Inventory', start: null, end: null, yearly: false }],
      today,
    )
    expect(days.some(d => d.key === 'Columbus Day')).toBe(false)
    expect(days.some(d => d.date === '2026-11-26')).toBe(false)
    expect(days.find(d => d.date === '2026-12-25')).toMatchObject({ start: '08:00', end: '12:00', source: 'holiday' })
    expect(days.some(d => d.date === '2027-01-01')).toBe(false)
  })

  test('a yearly own day repeats in later years within the year ahead; an off calendar adds nothing', () => {
    const days = derivedDays(
      calendar({ on: false }),
      [{ date: '2025-12-24', name: 'Christmas Eve', start: '08:00', end: '12:00', yearly: true }],
      today,
    )
    expect(days).toEqual([
      { date: '2026-12-24', name: 'Christmas Eve', start: '08:00', end: '12:00', source: 'repeat', key: '2025-12-24' },
    ])
  })
})

describe('holidays.set and closedDays.set', () => {
  const rows = (workspaceId: string, source: 'own' | 'holiday' | 'repeat') =>
    db
      .select()
      .from(availability_exceptions)
      .where(and(eq(availability_exceptions.workspace_id, workspaceId), eq(availability_exceptions.source, source)))

  test('following a calendar writes its days; own days and their years stay apart; members only read', async () => {
    const ws = await createWorkspace('Holiday Calendar Plumbing')
    const member = await addMember(ws.id, 'member')
    const lookup = await act(member, 'holidays.lookup', {})
    expect(lookup.status).toBe(200)
    expect(lookup.body.data).toMatchObject({ country: 'US', state: null })
    expect(lookup.body.data.states.some((s: { code: string }) => s.code === 'CA')).toBe(true)
    expect((await act(member, 'holidays.set', calendar())).status).toBe(403)

    expect((await act(ws.owner, 'holidays.set', calendar({ state: 'CA', off: ['Columbus Day'] }))).status).toBe(200)
    const holidays = await rows(ws.id, 'holiday')
    expect(holidays.length).toBeGreaterThan(8)
    expect(holidays.some(r => r.name === 'César Chávez Day')).toBe(true)
    expect(holidays.some(r => r.source_key === 'Columbus Day')).toBe(false)

    // Own days replace only own days; a yearly one comes back the year after.
    const year = Number(todayIn('America/New_York').slice(0, 4))
    const own = await act(ws.owner, 'closedDays.set', {
      days: [{ date: `${year - 1}-12-24`, name: 'Christmas Eve', yearly: true }],
    })
    expect(own.status).toBe(200)
    expect(own.body.data.closedDays).toEqual([
      { date: `${year - 1}-12-24`, name: 'Christmas Eve', start: null, end: null, yearly: true },
    ])
    expect((await rows(ws.id, 'repeat')).map(r => r.date)).toContain(`${year}-12-24`)
    expect((await rows(ws.id, 'holiday')).length).toBe(holidays.length)

    const settings = (await act(ws.owner, 'workspace.getSettings', {})).body.data
    expect(settings.holidays).toMatchObject({ on: true, country: 'US', state: 'CA', off: ['Columbus Day'] })
    expect(settings.closedDays).toHaveLength(1)
    expect(settings.derivedDays.some((d: { source: string }) => d.source === 'repeat')).toBe(true)

    // Off: the holidays go, the own day and its repeat stay.
    await act(ws.owner, 'holidays.set', calendar({ on: false, state: 'CA' }))
    expect(await rows(ws.id, 'holiday')).toEqual([])
    expect(await rows(ws.id, 'own')).toHaveLength(1)
    expect((await rows(ws.id, 'repeat')).length).toBeGreaterThan(0)
  })

  test('unknown places, twice-changed dates and changes without hours are refused', async () => {
    const ws = await createWorkspace('Holiday Refusals Plumbing')
    expect((await act(ws.owner, 'holidays.lookup', { country: 'ZZ' })).status).toBe(409)
    expect((await act(ws.owner, 'holidays.lookup', { country: 'US', state: 'ZZ' })).status).toBe(409)
    expect((await act(ws.owner, 'holidays.set', calendar({ country: 'ZZ' }))).status).toBe(409)
    const change = { date: '2099-01-01', name: 'x', open: true, start: null, end: null }
    expect((await act(ws.owner, 'holidays.set', calendar({ changes: [change, change] }))).status).toBe(409)
    expect((await act(ws.owner, 'holidays.set', calendar({ changes: [{ ...change, open: false }] }))).status).toBe(422)
  })
})
