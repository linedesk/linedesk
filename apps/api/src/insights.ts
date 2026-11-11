// Insights (insights.get): counts over the workspace's calls for the last 7, 30 or 90 days and the span
// before it, from calls, bookings, transcripts and business hours. One query, grouped by local day
// and hour; the totals, the daily series and the busiest hours and weekdays are folded from it.
import type { InsightCounts, InsightRange, InsightsData } from '@linedesk/actions'
import { availability_rules, type Tx, workspace_settings } from '@linedesk/db'
import { eq, sql } from 'drizzle-orm'
import { type Handler, Reject } from './handler-context.ts'

const DEFAULT_TIME_ZONE = 'America/New_York'

/** One row of the query: the calls of one local hour of one day, in the period or the one before. */
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
  spam: number
  seconds: number
  after_hours: number
  urgent_after_hours: number
}

const emptyCounts = (hoursOn: boolean): InsightCounts => ({
  calls: 0,
  answered: 0,
  missed: 0,
  urgent: 0,
  booked: 0,
  messages: 0,
  transferred: 0,
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
    spam: counts.spam + b.spam,
    minutes: counts.minutes + b.seconds, // seconds until the end, then rounded once
    afterHours: counts.afterHours === null ? null : counts.afterHours + b.after_hours,
    urgentAfterHours: counts.urgentAfterHours === null ? null : counts.urgentAfterHours + b.urgent_after_hours,
  }
}

const withMinutes = (counts: InsightCounts): InsightCounts => ({ ...counts, minutes: Math.round(counts.minutes / 60) })

/** The local dates of the period, oldest first, ending `today`. */
export function periodDays(today: string, days: number): string[] {
  const end = Date.parse(`${today}T00:00:00Z`)
  return Array.from({ length: days }, (_, i) => new Date(end - (days - 1 - i) * 86_400_000).toISOString().slice(0, 10))
}

/** Folds the query's buckets into what the page shows. Spam counts toward neither the series nor the busiest times. */
export function foldInsights(
  buckets: InsightBucket[],
  opts: { days: InsightRange; today: string; timeZone: string; hoursOn: boolean; jobValueCents: number | null },
): InsightsData {
  let current = emptyCounts(opts.hoursOn)
  let previous = emptyCounts(opts.hoursOn)
  const perDay = new Map<string, { answered: number; missed: number }>()
  const byHour = Array<number>(24).fill(0)
  const byWeekday = Array<number>(7).fill(0)
  for (const b of buckets) {
    if (!b.current) {
      previous = addBucket(previous, b)
      continue
    }
    current = addBucket(current, b)
    const day = perDay.get(b.day) ?? { answered: 0, missed: 0 }
    perDay.set(b.day, { answered: day.answered + b.answered, missed: day.missed + b.missed })
    const real = b.calls - b.spam
    byHour[b.hour] = (byHour[b.hour] ?? 0) + real
    const weekday = new Date(`${b.day}T00:00:00Z`).getUTCDay()
    byWeekday[weekday] = (byWeekday[weekday] ?? 0) + real
  }
  return {
    days: opts.days,
    timeZone: opts.timeZone,
    current: withMinutes(current),
    previous: withMinutes(previous),
    daily: periodDays(opts.today, opts.days).map(date => ({
      date,
      ...(perDay.get(date) ?? { answered: 0, missed: 0 }),
    })),
    byHour,
    byWeekday,
    jobValueCents: opts.jobValueCents,
  }
}

/** Whether the local time `local` (timestamp without time zone) is inside the business hours: a date's exception wins over the weekday. */
const openAt = (workspaceId: string, local: ReturnType<typeof sql>) => sql`case
  when exists (select 1 from availability_exceptions e where e.workspace_id = ${workspaceId} and e.date = ${local}::date)
  then exists (select 1 from availability_exceptions e where e.workspace_id = ${workspaceId} and e.date = ${local}::date
    and e.start_time is not null and ${local}::time >= e.start_time and ${local}::time < e.end_time)
  else exists (select 1 from availability_rules r where r.workspace_id = ${workspaceId} and r.weekday = extract(dow from ${local})
    and ${local}::time >= r.start_time and ${local}::time < r.end_time)
end`

async function queryBuckets(
  tx: Tx,
  workspaceId: string,
  timeZone: string,
  days: number,
): Promise<{ today: string; buckets: InsightBucket[] }> {
  const today = sql`(now() at time zone ${timeZone})::date`
  const startOf = (back: number) => sql`((${today} - ${back}::int)::timestamp at time zone ${timeZone})`
  const local = sql`c.local`
  const result = await tx.execute(sql`
    with c as (
      select c.*, (c.started_at at time zone ${timeZone}) as local,
        c.started_at >= ${startOf(days - 1)} as current,
        (c.outcome = 'hangup' and not exists (
          select 1 from transcript_segments s where s.call_id = c.id and s.speaker in ('agent', 'human')
        )) as missed,
        (c.outcome = 'booked' or exists (
          select 1 from bookings b where b.call_id = c.id and b.workspace_id = c.workspace_id and b.status <> 'cancelled'
        )) as booked_any
      from calls c
      where c.workspace_id = ${workspaceId} and c.deleted_at is null and c.source = 'phone' and c.direction = 'in'
        and c.status = 'completed' and c.started_at >= ${startOf(2 * days - 1)}
    ),
    k as (
      select c.*, coalesce(c.outcome = 'spam', false) as is_spam, not (${openAt(workspaceId, local)}) as closed from c
    )
    select current, to_char(local, 'YYYY-MM-DD') as day, extract(hour from local)::int as hour,
      count(*)::int as calls,
      count(*) filter (where not missed and not is_spam)::int as answered,
      count(*) filter (where missed)::int as missed,
      count(*) filter (where urgency = 'urgent' and not is_spam)::int as urgent,
      count(*) filter (where booked_any and not is_spam)::int as booked,
      count(*) filter (where outcome in ('message', 'callback') and not is_spam)::int as messages,
      count(*) filter (where (outcome = 'transferred' or transfer_result = 'connected') and not is_spam)::int as transferred,
      count(*) filter (where is_spam)::int as spam,
      coalesce(sum(duration_sec), 0)::int as seconds,
      count(*) filter (where closed and not missed and not is_spam)::int as after_hours,
      count(*) filter (where closed and not missed and not is_spam and urgency = 'urgent')::int as urgent_after_hours
    from k group by 1, 2, 3
  `)
  const [row] = (await tx.execute(sql`select to_char(${today}, 'YYYY-MM-DD') as today`)).rows as { today: string }[]
  return { today: row!.today, buckets: result.rows as InsightBucket[] }
}

export const insightsHandlers: Record<string, Handler> = {
  'insights.get': async ({ tx, actor }, input: { days: InsightRange }) => {
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
    const { today, buckets } = await queryBuckets(tx, actor.workspaceId, timeZone, input.days)
    const data = foldInsights(buckets, {
      days: input.days,
      today,
      timeZone,
      hoursOn: Boolean(settings?.business_hours_on && rule),
      jobValueCents: settings?.job_value_cents ?? null,
    })
    return { rows: {}, data }
  },
}
