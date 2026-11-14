// Public holidays and yearly days (Settings › Assistant › Hours & holidays). A workspace follows a holiday
// calendar (workspace_settings.holidays: country, state, the holidays it is open on, single changed dates);
// its own days can repeat every year. syncDerivedDays writes both into availability_exceptions for the next
// twelve months (source `holiday` and `repeat`), so every reader of closed days (the assistant's hours, free
// slots, Insights) sees them as ordinary rows; a daily job keeps the window rolling. Holiday data comes from
// the date-holidays library, which carries it with it: no outside service, nothing to set up when self-hosting.
import type { DerivedDay, HolidayLookupData, HolidayPlace } from '@linedesk/actions'
import { availability_exceptions, type Tx, workspace_settings } from '@linedesk/db'
import type { HolidayCalendar, HolidayChange } from '@linedesk/db/types'
import Holidays from 'date-holidays'
import { and, asc, eq, gte, inArray, isNotNull, or } from 'drizzle-orm'
import { type Handler, Reject } from './handler-context.ts'

/** Same default as the workspace settings. */
const DEFAULT_TIME_ZONE = 'America/New_York'
/** Holiday kinds a business closes for; observances (Valentine's Day) and school holidays are left out. */
const CLOSING_TYPES = new Set(['public', 'bank'])
/** What date-holidays appends to a holiday moved off a weekend. */
const SUBSTITUTE = / \(substitute day\)$/

const byName = (places: Record<string, string> | undefined): HolidayPlace[] =>
  Object.entries(places ?? {})
    .map(([code, name]) => ({ code, name }))
    .sort((a, b) => a.name.localeCompare(b.name))

let countryList: HolidayPlace[] | null = null
const countries = () => (countryList ??= byName(new Holidays().getCountries('en')))

/** The country whose holidays a time zone suggests ("Europe/Berlin": DE); null when none or several. */
export function countryOfTimeZone(timeZone: string): string | null {
  const h = new Holidays()
  const found = countries().filter(c => {
    h.init(c.code)
    return (h.getTimezones() ?? []).includes(timeZone)
  })
  return found.length === 1 ? found[0]!.code : null
}

export const addDays = (date: string, days: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10)

/** The last day of the year from `date` on: "2026-11-14" → "2027-11-13". */
export const yearAfter = (date: string) => addDays(`${Number(date.slice(0, 4)) + 1}${date.slice(4)}`, -1)

/** Today's date (YYYY-MM-DD) in a time zone. */
export const todayIn = (timeZone: string, now = Date.now()) =>
  new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)

/** One date a holiday closes: `key` its name every year; a holiday moved off a weekend is "… (observed)". */
export type HolidayDate = { key: string; date: string; name: string }

/**
 * The public and bank holidays of a country (and state) from `from` to `last`, one per date (the first listed
 * wins: "Christmas Day (observed)" over "Christmas Eve").
 */
export function holidayDates(country: string, state: string | null, from: string, last: string): HolidayDate[] {
  const h = state ? new Holidays(country, state) : new Holidays(country)
  // The country's own English where it has one ("Labor Day" in the US), else plain English.
  const english = (h.getLanguages() ?? []).find(l => l.startsWith('en')) ?? 'en'
  const seen = new Set<string>()
  const days: HolidayDate[] = []
  for (let year = Number(from.slice(0, 4)); year <= Number(last.slice(0, 4)); year++) {
    for (const holiday of h.getHolidays(year, english) ?? []) {
      const date = holiday.date.slice(0, 10)
      if (!CLOSING_TYPES.has(holiday.type) || date < from || date > last || seen.has(date)) continue
      seen.add(date)
      const key = holiday.name.replace(SUBSTITUTE, '').slice(0, 80)
      days.push({ key, date, name: SUBSTITUTE.test(holiday.name) ? `${key} (observed)` : key })
    }
  }
  return days.sort((a, b) => a.date.localeCompare(b.date))
}

/** Each holiday of the year from `today` once, at its first date (the observed day when that comes first). */
export function holidayList(country: string, state: string | null, today: string): HolidayDate[] {
  const seen = new Set<string>()
  return holidayDates(country, state, today, yearAfter(today)).filter(d => !seen.has(d.key) && !!seen.add(d.key))
}

function checkPlace(country: string, state: string | null): HolidayPlace[] {
  if (!countries().some(c => c.code === country)) throw new Reject(`no holidays known for country ${country}`)
  const states = byName(new Holidays().getStates(country, 'en'))
  if (state && !states.some(s => s.code === state)) throw new Reject(`${country} has no state ${state}`)
  return states
}

export function lookupHolidays(input: { country?: string; state?: string }, timeZone: string): HolidayLookupData {
  const country = input.country ?? countryOfTimeZone(timeZone) ?? 'US'
  const state = input.state ?? null
  const states = checkPlace(country, state)
  return { countries: countries(), country, states, state, holidays: holidayList(country, state, todayIn(timeZone)) }
}

/**
 * The derived days from `today` to a year on: the calendar's holidays (less the ones it is open on) and the
 * later years of the own yearly days, each date once (own days win over both, holidays over repeats), with the
 * calendar's changes for single dates applied.
 */
export function derivedDays(
  calendar: HolidayCalendar | null,
  own: readonly { date: string; name: string; start: string | null; end: string | null; yearly: boolean }[],
  today: string,
): DerivedDay[] {
  const last = yearAfter(today)
  const taken = new Set(own.filter(d => d.date >= today).map(d => d.date))
  const days: DerivedDay[] = []
  const add = (day: DerivedDay) => {
    if (taken.has(day.date)) return
    taken.add(day.date)
    days.push(day)
  }
  if (calendar?.on) {
    const off = new Set(calendar.off)
    for (const h of holidayDates(calendar.country, calendar.state, today, last)) {
      if (!off.has(h.key)) add({ date: h.date, name: h.name, start: null, end: null, source: 'holiday', key: h.key })
    }
  }
  for (const d of own.filter(o => o.yearly)) {
    for (let year = Math.max(Number(d.date.slice(0, 4)) + 1, Number(today.slice(0, 4))); ; year++) {
      const date = `${year}${d.date.slice(4)}`
      if (date > last) break
      // February 29 repeats in leap years only.
      if (date < today || addDays(date, 0) !== date) continue
      add({ date, name: d.name, start: d.start, end: d.end, source: 'repeat', key: d.date })
    }
  }
  const changes = new Map((calendar?.changes ?? []).map(c => [c.date, c]))
  return days
    .filter(d => !changes.get(d.date)?.open)
    .map(d => {
      const change = changes.get(d.date)
      return change ? { ...d, start: change.start, end: change.end } : d
    })
    .sort((a, b) => a.date.localeCompare(b.date))
}

async function settingsOf(tx: Tx, workspaceId: string) {
  const [row] = await tx
    .select({ timezone: workspace_settings.timezone, holidays: workspace_settings.holidays })
    .from(workspace_settings)
    .where(eq(workspace_settings.workspace_id, workspaceId))
  return { timeZone: row?.timezone ?? DEFAULT_TIME_ZONE, holidays: row?.holidays ?? null }
}

const derivedSources = inArray(availability_exceptions.source, ['holiday', 'repeat'])

/**
 * Rewrites the workspace's derived days from today on (past ones stay, so Insights still knows the business
 * was closed then). Runs after every change to the calendar, the own days or the time zone, and daily.
 */
export async function syncDerivedDays(tx: Tx, workspaceId: string, now = Date.now()) {
  const { timeZone, holidays } = await settingsOf(tx, workspaceId)
  const today = todayIn(timeZone, now)
  const own = await tx
    .select()
    .from(availability_exceptions)
    .where(and(eq(availability_exceptions.workspace_id, workspaceId), eq(availability_exceptions.source, 'own')))
  await tx
    .delete(availability_exceptions)
    .where(
      and(
        eq(availability_exceptions.workspace_id, workspaceId),
        derivedSources,
        gte(availability_exceptions.date, today),
      ),
    )
  const days = derivedDays(
    holidays,
    own.map(d => ({
      date: d.date,
      name: d.name,
      start: d.start_time?.slice(0, 5) ?? null,
      end: d.end_time?.slice(0, 5) ?? null,
      yearly: d.yearly,
    })),
    today,
  )
  if (days.length) {
    await tx.insert(availability_exceptions).values(
      days.map(d => ({
        id: `ae_${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`,
        workspace_id: workspaceId,
        date: d.date,
        name: d.name,
        start_time: d.start,
        end_time: d.end,
        source: d.source,
        source_key: d.key,
      })),
    )
  }
}

/** The derived days from today on, as the settings page shows them. */
export async function derivedDaysOf(tx: Tx, workspaceId: string, timeZone: string): Promise<DerivedDay[]> {
  const rows = await tx
    .select()
    .from(availability_exceptions)
    .where(
      and(
        eq(availability_exceptions.workspace_id, workspaceId),
        derivedSources,
        gte(availability_exceptions.date, todayIn(timeZone)),
      ),
    )
    .orderBy(asc(availability_exceptions.date))
  return rows.map(r => ({
    date: r.date,
    name: r.name,
    start: r.start_time?.slice(0, 5) ?? null,
    end: r.end_time?.slice(0, 5) ?? null,
    source: r.source as DerivedDay['source'],
    key: r.source_key ?? '',
  }))
}

/** The workspaces the daily job rolls on: those with a holiday calendar, a yearly day or derived days to clear. */
export async function workspacesWithDerivedDays(tx: Tx): Promise<string[]> {
  const withCalendar = await tx
    .select({ id: workspace_settings.workspace_id })
    .from(workspace_settings)
    .where(isNotNull(workspace_settings.holidays))
  const withDays = await tx
    .selectDistinct({ id: availability_exceptions.workspace_id })
    .from(availability_exceptions)
    .where(or(eq(availability_exceptions.yearly, true), derivedSources))
  return [...new Set([...withCalendar, ...withDays].map(r => r.id))]
}

export const publicHolidayHandlers: Record<string, Handler> = {
  'holidays.lookup': async ({ tx, actor }, input: { country?: string; state?: string }) => {
    if (!actor.workspaceId) throw new Reject('no workspace')
    const { timeZone } = await settingsOf(tx, actor.workspaceId)
    return { rows: {}, data: lookupHolidays(input, timeZone) }
  },

  'holidays.set': async ({ tx, actor }, input: HolidayCalendar) => {
    if (!actor.workspaceId) throw new Reject('no workspace')
    const workspace_id = actor.workspaceId
    checkPlace(input.country, input.state)
    const { timeZone } = await settingsOf(tx, workspace_id)
    const today = todayIn(timeZone)
    // Changes to days gone by change nothing any more; dropping them keeps the list short over the years.
    const changes: HolidayChange[] = input.changes.filter(c => c.date >= today)
    if (new Set(changes.map(c => c.date)).size !== changes.length) throw new Reject('each date can be changed once')
    const holidays: HolidayCalendar = {
      on: input.on,
      country: input.country,
      state: input.state,
      off: [...new Set(input.off)],
      changes,
    }
    await tx
      .insert(workspace_settings)
      .values({ workspace_id, timezone: timeZone, holidays })
      .onConflictDoUpdate({ target: workspace_settings.workspace_id, set: { holidays } })
    await syncDerivedDays(tx, workspace_id)
    return { rows: {}, data: { holidays, derivedDays: await derivedDaysOf(tx, workspace_id, timeZone) } }
  },
}
