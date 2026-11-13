// Insights: how the assistant did over a period (the last 7 or 30 days, this or last month, the last
// 12 months or everything since the first call), counted on the server from the workspace's calls and
// bookings (nothing is stored for it). Members see it; the value of a booked job
// (workspace.updateSettings, jobValueCents) is set by owners and admins.
import { z } from 'zod'
import { defineAction } from './define.ts'

/** The periods the page offers, in the order of its menu. */
export const insightPeriods = ['7d', '30d', 'month', 'lastMonth', '12m', 'all'] as const
export type InsightPeriod = (typeof insightPeriods)[number]
/** The longest custom range (ten years, like the export). */
export const INSIGHTS_MAX_DAYS = 3660
/** The old 7 / 30 / 90 days, still accepted as `days`. */
export const insightRanges = [7, 30, 90] as const
export type InsightRange = (typeof insightRanges)[number]

/** The value of a booked job an owner can set, in cents (up to $1,000,000). */
export const JOB_VALUE_MAX_CENTS = 100_000_000

/** The currencies a job value can be set in (workspace.updateSettings, jobValueCurrency); USD by default. */
export const jobValueCurrencies = ['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'CHF'] as const
export type JobValueCurrency = (typeof jobValueCurrencies)[number]

/**
 * Counts for one period; the same fields for the period and the one before it. Every real call is
 * exactly one of spam, missed, booked, transferred, messages or other, so those add up to `calls`.
 */
export type InsightCounts = {
  /** Inbound phone calls (no test or sample calls, no outbound calls). */
  calls: number
  /** Someone picked up: the assistant or the team (not missed, not spam). */
  answered: number
  /** Nobody picked up (the assistant was not running or not set up). */
  missed: number
  urgent: number
  /** Calls that ended with an appointment the assistant booked (a booking from the call or the outcome). */
  booked: number
  /** The assistant took a message or a callback request (and booked nothing, transferred nobody). */
  messages: number
  /** Put through to a person (and nothing booked). */
  transferred: number
  /** Answered calls that ended with none of the above: a question answered, a booking moved or cancelled. */
  other: number
  spam: number
  /** Talk time of all calls, rounded to whole minutes. */
  minutes: number
  /** Answered calls that came in outside business hours; null when the workspace uses no hours. */
  afterHours: number | null
  /** Urgent calls among them; null like afterHours. */
  urgentAfterHours: number | null
}

/** One day of the period: its counts (minutes rounded per day). */
export type InsightDay = { date: string } & InsightCounts

export type InsightsData = {
  /** `custom`: the `from` and `to` asked for; `days`: the older `days` input. */
  period: InsightPeriod | 'custom' | 'days'
  /** The number of days in the period. */
  days: number
  /** First and last day of the period, YYYY-MM-DD in the workspace time zone (`to` is today or earlier). */
  from: string
  to: string
  today: string
  /** The period compared with; null for everything since the first call. */
  compareWith: { from: string; to: string } | null
  timeZone: string
  current: InsightCounts
  previous: InsightCounts
  /** One entry per day of the period, oldest first. */
  daily: InsightDay[]
  /** Calls per hour of the day (0-23) and per weekday (0 = Sunday), in the workspace time zone, spam left out. */
  byHour: number[]
  byWeekday: number[]
  /** Calls per weekday (0 = Sunday) and hour, the same calls as byHour and byWeekday. */
  byWeekdayHour: number[][]
  /** The day of the workspace's first counted call; null when there is none yet. */
  firstCall: string | null
  /** The value of one booked job in cents; null when nobody set it. */
  jobValueCents: number | null
  /** The currency of jobValueCents. Missing from an older API: USD. */
  jobValueCurrency?: JobValueCurrency
}

export const insightsGet = defineAction({
  name: 'insights.get',
  description:
    "How the assistant did over a period and the period before it. `period`: 7d, 30d (default), month (this month so far, compared with the same days of last month), lastMonth, 12m (the last 12 calendar months, this one included), all (since the first call, nothing to compare) or custom (`from` to `to`, YYYY-MM-DD in the business time zone, both included, compared with the same number of days before). The older `days` (7, 30 or 90: the last that many days) still works. Returns calls answered and missed, urgent, booked, messages taken, transferred, other answered calls, spam blocked, minutes, calls after business hours, every day's counts, calls per hour, per weekday and per weekday and hour (the workspace's time zone), the first call's day, and the value of a booked job and its currency when one is set.",
  input: z
    .object({
      period: z.enum([...insightPeriods, 'custom']).optional(),
      from: z.iso.date().optional(),
      to: z.iso.date().optional(),
      days: z.union([z.literal(7), z.literal(30), z.literal(90)]).optional(),
    })
    .refine(i => i.period !== 'custom' || (i.from && i.to), {
      message: 'A custom period needs from and to',
      path: ['from'],
    })
    .refine(i => !i.from || !i.to || i.from <= i.to, { message: 'The first day comes before the last', path: ['to'] })
    .refine(i => !i.from || !i.to || (Date.parse(i.to) - Date.parse(i.from)) / 86_400_000 < INSIGHTS_MAX_DAYS, {
      message: `A period covers at most ${INSIGHTS_MAX_DAYS} days`,
      path: ['to'],
    }),
  permission: 'call:read',
  readOnly: true,
})
