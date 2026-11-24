// Insights (insights.get): counts over the workspace's calls for a period and the period it is compared
// with, from calls, bookings, transcripts and business hours. One query, grouped by local day and hour;
// the totals, the daily rows and the busiest hours and weekdays are folded from it.
import type {
  InsightCounts,
  InsightDay,
  InsightPeriod,
  InsightRange,
  InsightsData,
  JobValueCurrency,
} from '@linedesk/actions'
import { availability_rules, type Tx, workspace_settings } from '@linedesk/db'
import { eq, sql } from 'drizzle-orm'
import { type Handler, Reject } from './handler-context.ts'

const DEFAULT_TIME_ZONE = 'America/New_York'
const DAY_MS = 86_400_000

/** One row of the query: the calls of one local hour of one day, in the period (current) or the one compared with. */
export type InsightBucket = {
  current: boolean
  /** Local date, YYYY-MM-DD. */
  day: string
  hour: number
  calls: number
  answered: number
  missed: number
  urgent: number
  booked: number
  messages: number
  transferred: number
  other: number
  spam: number
  seconds: number
  after_hours: number
  urgent_after_hours: number
}

// --- Periods -------------------------------------------------------------------------------------

/** A span of local days, both included. */
export type DaySpan = { from: string; to: string }

const ms = (date: string) => Date.parse(`${date}T00:00:00Z`)
const iso = (t: number) => new Date(t).toISOString().slice(0, 10)
export const shiftDays = (date: string, n: number) => iso(ms(date) + n * DAY_MS)
export const spanDays = (s: DaySpan) => Math.round((ms(s.to) - ms(s.from)) / DAY_MS) + 1

/** The first of the month `n` months after `date`'s month (n may be negative). */
function monthStart(date: string, n = 0): string {
  const d = new Date(ms(date))
  return iso(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1))
}
/** `date` moved by `n` months, kept inside the target month (Mar 31 − 1 month = Feb 28). */
function shiftMonths(date: string, n: number): string {
  const first = monthStart(date, n)
  const last = shiftDays(monthStart(date, n + 1), -1)
  const day = Number(date.slice(8, 10))
  return day > Number(last.slice(8, 10)) ? last : `${first.slice(0, 8)}${String(day).padStart(2, '0')}`
}

/** The days of a period and of the period it is compared with (null: nothing to compare with). */
export function periodSpans(
  period: InsightPeriod | { days: number } | DaySpan,
  today: string,
  firstCall: string | null,
): { span: DaySpan; compareWith: DaySpan | null } {
  const lastDays = (n: number) => {
    const span = { from: shiftDays(today, -(n - 1)), to: today }
    return { span, compareWith: { from: shiftDays(span.from, -n), to: shiftDays(span.from, -1) } }
  }
  if (typeof period === 'object' && 'days' in period) return lastDays(period.days)
  if (typeof period === 'object') {
    // A custom range ends today at the latest; the comparison is the same number of days right before it.
    const earlier = (a: string, b: string) => (a.localeCompare(b) < 0 ? a : b)
    const to = earlier(period.to, today)
    const span = { from: earlier(period.from, to), to }
    const n = spanDays(span)
    return { span, compareWith: { from: shiftDays(span.from, -n), to: shiftDays(span.from, -1) } }
  }
  switch (period) {
    case '7d':
      return lastDays(7)
    case '30d':
      return lastDays(30)
    case 'month': {
      const span = { from: monthStart(today), to: today }
      return { span, compareWith: { from: monthStart(today, -1), to: shiftMonths(today, -1) } }
    }
    case 'lastMonth': {
      const span = { from: monthStart(today, -1), to: shiftDays(monthStart(today), -1) }
      return { span, compareWith: { from: monthStart(today, -2), to: shiftDays(monthStart(today, -1), -1) } }
    }
    case '12m': {
      const span = { from: monthStart(today, -11), to: today }
      return { span, compareWith: { from: monthStart(today, -23), to: shiftMonths(today, -12) } }
    }
    case 'all':
      return { span: { from: firstCall && firstCall < today ? firstCall : today, to: today }, compareWith: null }
  }
}

/** The local dates of a span, oldest first. */
export function spanDates(s: DaySpan): string[] {
  return Array.from({ length: spanDays(s) }, (_, i) => shiftDays(s.from, i))
}

// --- Folding -------------------------------------------------------------------------------------

const emptyCounts = (hoursOn: boolean): InsightCounts => ({
  calls: 0,
  answered: 0,
  missed: 0,
  urgent: 0,
  booked: 0,
  messages: 0,
  transferred: 0,
  other: 0,
  spam: 0,
  minutes: 0,
  afterHours: hoursOn ? 0 : null,
  urgentAfterHours: hoursOn ? 0 : null,
})

function addBucket(counts: InsightCounts, b: InsightBucket): InsightCounts {
  return {
    calls: counts.calls + b.calls,
    answered: counts.answered + b.answered,
    missed: counts.missed + b.missed,
    urgent: counts.urgent + b.urgent,
    booked: counts.booked + b.booked,
    messages: counts.messages + b.messages,
    transferred: counts.transferred + b.transferred,
    other: counts.other + b.other,
    spam: counts.spam + b.spam,
    minutes: counts.minutes + b.seconds, // seconds until the end, then rounded once
    afterHours: counts.afterHours === null ? null : counts.afterHours + b.after_hours,
    urgentAfterHours: counts.urgentAfterHours === null ? null : counts.urgentAfterHours + b.urgent_after_hours,
  }
}

const withMinutes = (counts: InsightCounts): InsightCounts => ({ ...counts, minutes: Math.round(counts.minutes / 60) })

type FoldOptions = {
  period: InsightsData['period']
  today: string
  span: DaySpan
  compareWith: DaySpan | null
  firstCall: string | null
  timeZone: string
  hoursOn: boolean
  jobValueCents: number | null
  jobValueCurrency: JobValueCurrency
}

/** Folds the query's buckets into what the page shows. Spam counts toward neither the busiest times. */
export function foldInsights(buckets: InsightBucket[], opts: FoldOptions): InsightsData {
  let current = emptyCounts(opts.hoursOn)
  let previous = emptyCounts(opts.hoursOn)
  const perDay = new Map<string, InsightCounts>()
  const byHour = Array<number>(24).fill(0)
  const byWeekday = Array<number>(7).fill(0)
  const byWeekdayHour = Array.from({ length: 7 }, () => Array<number>(24).fill(0))
  for (const b of buckets) {
    if (!b.current) {
      previous = addBucket(previous, b)
      continue
    }
    current = addBucket(current, b)
    perDay.set(b.day, addBucket(perDay.get(b.day) ?? emptyCounts(opts.hoursOn), b))
    const real = b.calls - b.spam
    const weekday = new Date(`${b.day}T00:00:00Z`).getUTCDay()
    byHour[b.hour] = (byHour[b.hour] ?? 0) + real
    byWeekday[weekday] = (byWeekday[weekday] ?? 0) + real
    byWeekdayHour[weekday]![b.hour] = (byWeekdayHour[weekday]![b.hour] ?? 0) + real
  }
  const daily: InsightDay[] = spanDates(opts.span).map(date => ({
    date,
    ...withMinutes(perDay.get(date) ?? emptyCounts(opts.hoursOn)),
  }))
  return {
    period: opts.period,
    days: spanDays(opts.span),
    from: opts.span.from,
    to: opts.span.to,
    today: opts.today,
    compareWith: opts.compareWith,
    timeZone: opts.timeZone,
    current: withMinutes(current),
    previous: withMinutes(previous),
    daily,
    byHour,
    byWeekday,
    byWeekdayHour,
    firstCall: opts.firstCall,
    jobValueCents: opts.jobValueCents,
    jobValueCurrency: opts.jobValueCurrency,
  }
}

// --- Query ---------------------------------------------------------------------------------------

/** Whether the local time `local` (timestamp without time zone) is inside the business hours: a date's exception wins over the weekday. */
const openAt = (workspaceId: string, local: ReturnType<typeof sql>) => sql`case
  when exists (select 1 from availability_exceptions e where e.workspace_id = ${workspaceId} and e.date = ${local}::date)
  then exists (select 1 from availability_exceptions e where e.workspace_id = ${workspaceId} and e.date = ${local}::date
    and e.start_time is not null and ${local}::time >= e.start_time and ${local}::time < e.end_time)
  else exists (select 1 from availability_rules r where r.workspace_id = ${workspaceId} and r.weekday = extract(dow from ${local})
    and ${local}::time >= r.start_time and ${local}::time < r.end_time)
end`

/** The calls Insights counts: real inbound phone calls that are over. */
const counted = (workspaceId: string) =>
  sql`c.workspace_id = ${workspaceId} and c.deleted_at is null and c.source = 'phone' and c.direction = 'in'
    and not c.from_own_number and c.status = 'completed'`

async function todayAndFirstCall(tx: Tx, workspaceId: string, timeZone: string) {
  const [row] = (
    await tx.execute(sql`
      select to_char((now() at time zone ${timeZone})::date, 'YYYY-MM-DD') as today,
        (select to_char(min(c.started_at) at time zone ${timeZone}, 'YYYY-MM-DD') from calls c where ${counted(workspaceId)}) as first_call
    `)
  ).rows as { today: string; first_call: string | null }[]
  return { today: row!.today, firstCall: row!.first_call }
}

async function queryBuckets(
  tx: Tx,
  workspaceId: string,
  timeZone: string,
  span: DaySpan,
  compareWith: DaySpan | null,
): Promise<InsightBucket[]> {
  const startOf = (date: string) => sql`(${date}::date::timestamp at time zone ${timeZone})`
  const inSpan = (s: DaySpan) =>
    sql`(c.started_at >= ${startOf(s.from)} and c.started_at < ${startOf(shiftDays(s.to, 1))})`
  const local = sql`c.local`
  const result = await tx.execute(sql`
    with c as (
      select c.*, (c.started_at at time zone ${timeZone}) as local, ${inSpan(span)} as current,
        coalesce(c.outcome = 'hangup' and not exists (
          select 1 from transcript_segments s where s.call_id = c.id and s.speaker in ('agent', 'human')
        ), false) as missed,
        coalesce(c.outcome = 'booked' or exists (
          select 1 from bookings b where b.call_id = c.id and b.workspace_id = c.workspace_id and b.status <> 'cancelled'
        ), false) as booked_any,
        coalesce(c.outcome = 'spam', false) as is_spam
      from calls c
      where ${counted(workspaceId)} and (${inSpan(span)}${compareWith ? sql` or ${inSpan(compareWith)}` : sql``})
    ),
    k as (
      select c.*,
        not (${openAt(workspaceId, local)}) as closed,
        (not missed and not is_spam) as answered_any,
        (not missed and not is_spam and not booked_any and coalesce(outcome = 'transferred' or transfer_result = 'connected', false)) as transferred_only
      from c
    )
    select current, to_char(local, 'YYYY-MM-DD') as day, extract(hour from local)::int as hour,
      count(*)::int as calls,
      count(*) filter (where answered_any)::int as answered,
      count(*) filter (where missed and not is_spam)::int as missed,
      count(*) filter (where urgency = 'urgent' and not is_spam)::int as urgent,
      count(*) filter (where answered_any and booked_any)::int as booked,
      count(*) filter (where answered_any and not booked_any and not transferred_only and outcome in ('message', 'callback'))::int as messages,
      count(*) filter (where transferred_only)::int as transferred,
      count(*) filter (where answered_any and not booked_any and not transferred_only and outcome is distinct from 'message' and outcome is distinct from 'callback')::int as other,
      count(*) filter (where is_spam)::int as spam,
      coalesce(sum(duration_sec), 0)::int as seconds,
      count(*) filter (where closed and answered_any)::int as after_hours,
      count(*) filter (where closed and answered_any and urgency = 'urgent')::int as urgent_after_hours
    from k group by 1, 2, 3
  `)
  return result.rows as InsightBucket[]
}

export const insightsHandlers: Record<string, Handler> = {
  'insights.get': async (
    { tx, actor },
    input: { period?: InsightPeriod | 'custom'; from?: string; to?: string; days?: InsightRange },
  ) => {
    if (!actor.workspaceId) throw new Reject('no workspace')
    const [settings] = await tx
      .select()
      .from(workspace_settings)
      .where(eq(workspace_settings.workspace_id, actor.workspaceId))
    const [rule] = await tx
      .select({ id: availability_rules.id })
      .from(availability_rules)
      .where(eq(availability_rules.workspace_id, actor.workspaceId))
      .limit(1)
    const timeZone = settings?.timezone ?? DEFAULT_TIME_ZONE
    const { today, firstCall } = await todayAndFirstCall(tx, actor.workspaceId, timeZone)
    // An older page asks for `days`; without either, the last 30 days.
    const period =
      input.period === 'custom' && input.from && input.to
        ? { from: input.from, to: input.to }
        : input.period && input.period !== 'custom'
          ? input.period
          : input.days
            ? { days: input.days }
            : '30d'
    const { span, compareWith } = periodSpans(period, today, firstCall)
    const buckets = await queryBuckets(tx, actor.workspaceId, timeZone, span, compareWith)
    const data = foldInsights(buckets, {
      period: typeof period === 'string' ? period : 'days' in period ? 'days' : 'custom',
      today,
      span,
      compareWith,
      firstCall,
      timeZone,
      hoursOn: Boolean(settings?.business_hours_on && rule),
      jobValueCents: settings?.job_value_cents ?? null,
      jobValueCurrency: settings?.job_value_currency ?? 'USD',
    })
    return { rows: {}, data }
  },
}
