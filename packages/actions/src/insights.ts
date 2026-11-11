// Insights: how the assistant did over the last 7, 30 or 90 days, counted on the server from the
// workspace's calls and bookings (nothing is stored for it). Members see it; the value of a booked
// job (workspace.updateSettings, jobValueCents) is set by owners and admins.
import { z } from 'zod'
import { defineAction } from './define.ts'

export const insightRanges = [7, 30, 90] as const
export type InsightRange = (typeof insightRanges)[number]

/** The value of a booked job an owner can set, in cents (up to $1,000,000). */
export const JOB_VALUE_MAX_CENTS = 100_000_000

/** Counts for one period; the same fields for the period and the one before it. */
export type InsightCounts = {
  /** Inbound phone calls (no test or sample calls, no outbound calls). */
  calls: number
  /** Someone picked up: the assistant or the team (not missed, not spam). */
  answered: number
  /** Nobody picked up (the assistant was not running or not set up). */
  missed: number
  urgent: number
  /** Calls that ended with an appointment the assistant booked (a booking from the call, the outcome or the tag). */
  booked: number
  /** The assistant took a message or a callback request (outcome or tag). */
  messages: number
  transferred: number
  spam: number
  /** Talk time of all calls, rounded to whole minutes. */
  minutes: number
  /** Answered calls that came in outside business hours; null when the workspace uses no hours. */
  afterHours: number | null
  /** Urgent calls among them; null like afterHours. */
  urgentAfterHours: number | null
}

export type InsightsData = {
  days: InsightRange
  timeZone: string
  current: InsightCounts
  previous: InsightCounts
  /** One entry per day of the period, oldest first, in the workspace time zone (YYYY-MM-DD). */
  daily: { date: string; answered: number; missed: number }[]
  /** Calls per hour of the day (0-23) and per weekday (0 = Sunday), in the workspace time zone. */
  byHour: number[]
  byWeekday: number[]
  /** The value of one booked job in cents; null when nobody set it. */
  jobValueCents: number | null
}

export const insightsGet = defineAction({
  name: 'insights.get',
  description:
    "How the assistant did over the last `days` days (7, 30 or 90) and the same span before it: calls answered and missed, urgent, booked, messages taken, transferred, spam blocked, minutes, calls after business hours, calls per day, per hour and per weekday (the workspace's time zone), and the value of a booked job when one is set.",
  input: z.object({ days: z.union([z.literal(7), z.literal(30), z.literal(90)]).default(7) }),
  permission: 'call:read',
  readOnly: true,
})
