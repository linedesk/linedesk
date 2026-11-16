// The assistant's booking tools: find free times in one of its calendars, and book one. Both go
// through the API (calendar.findSlots, appointment.book); the API checks the calendar is the
// assistant's and the time still free. Results are short sentences the model can say.
import { appointmentBook, appointmentCancel, appointmentReschedule, type BookData, calendarFindSlots, type FindSlotsData } from '@linedesk/actions'
import { ActionError, type ApiClient } from './api-client.ts'
import type { CallLog } from './call-log.ts'
import type { CallSession } from './call-session.ts'
import { type Day, resolveDay, todayIn } from './spoken-day.ts'
import { z } from 'zod'

/** Times the model gets to choose from: a few per day over a few days reads well on the phone. */
const PER_DAY = 2
const MAX_OFFERED = 6
/** Slots asked from the API; enough to spread over several days. */
const SEARCH_LIMIT = 60

/** A booking as the caller described it: its day (as the caller said it, resolveDay) and the name it is under; the API checks both. */
export type DescribedBooking = { booking_date: string }
/** Descriptions that matched no booking before the assistant stops trying on a call (no guessing names or days). */
export const MAX_DESCRIBE_ATTEMPTS = 2

export type FindSlotsArgs = { appointment_type_id: string; calendar_id?: string | null; from_date?: string | null; to_date?: string | null }
export type BookArgs = {
  appointment_type_id: string; calendar_id?: string | null; start: string; caller_name?: string | null; reason: string; address?: string | null; email?: string | null
}

/** `count` items spread evenly over `list`, first and last included (all of it when it is short). */
const evenly = <T>(list: T[], count: number): T[] =>
  list.length <= count ? list : Array.from({ length: count }, (_, i) => list[Math.round((i * (list.length - 1)) / (count - 1))]!)

/**
 * The times to offer, earliest day first: PER_DAY per local day spread over the day (its first and its last free
 * time, so an afternoon is offered too), MAX_OFFERED in all; a search of a single day gives up to MAX_OFFERED of it.
 */
export function spreadSlots(slots: FindSlotsData['slots']): FindSlotsData['slots'] {
  const days = new Map<string, FindSlotsData['slots']>()
  for (const slot of slots) {
    const day = slot.label.split(' at ')[0]!
    days.set(day, [...(days.get(day) ?? []), slot])
  }
  if (days.size === 1) return evenly(slots, MAX_OFFERED)
  return [...days.values()].flatMap(day => evenly(day, PER_DAY)).slice(0, MAX_OFFERED)
}

/**
 * Read with every list of free times. Models shifted dates when they spoke them ("Wednesday, November twelfth" for
 * Wednesday, November 11) and called a day full that was never searched.
 */
const SLOT_RULES =
  'Say each time with its weekday and date exactly as written; never change the date. These are only the earliest free days: ' +
  'if the caller wants a day that is not listed, call find_slots again with from_date and to_date set to that day before you say anything about it.'

/**
 * The times are the business's local times. A caller in New York who asked for 1 PM Eastern was offered
 * "1:00 PM Eastern Time" and booked at 1:00 PM Pacific.
 */
export const zoneRule = (timeZone: string) =>
  `All these times are in the owner's time zone (${timeZone}). If the caller means another time zone, convert, and say the time in both zones; never call a time by another zone's name without converting it.`

/** A local date and time without a zone, as models write a start they copied from a label ("2026-11-17T08:30:00"). */
const LOCAL_TIME = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::00(?:\.0+)?)?$/

/**
 * Whether `given` is the instant `start`: the same instant, or, written without a zone, the same wall-clock time in
 * `timeZone` (the zone the times were offered in). Exported for tests.
 */
export function sameStart(start: string, given: string, timeZone: string): boolean {
  const local = LOCAL_TIME.exec(given)
  if (!local) return Date.parse(start) === Date.parse(given)
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(new Date(start))
      .map(p => [p.type, p.value]),
  )
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}` === `${local[1]}T${local[2]}:${local[3]}`
}

const failure = (e: unknown) => (e instanceof ActionError ? e.message.replace(/^[\w.]+ failed \(\d+\): /, '') : 'the calendar did not answer')

export function bookingTools(api: ApiClient, call: CallSession, log: CallLog) {
  const { callId } = call
  const typeName = (id: string) => call.booking?.appointmentTypes.find(t => t.id === id)?.name ?? 'appointment'

  /**
   * The times find_slots offered on this call, by key ("s3"). Models wrote starts of their own (1:00 PM as 13:00 UTC,
   * five in the morning in Portland); a key they copy, and a start nobody offered is never sent.
   */
  const offeredSlots = new Map<string, FindSlotsData['slots'][number]>()
  /** What this call booked, by start. */
  const bookedHere = new Map<string, string>()
  /** The zone find_slots read its times in: a start the model writes without a zone is a time of that zone. */
  let offeredZone = call.booking?.timeZone ?? 'America/New_York'
  const offeredStart = (given: string) => {
    const key = given.trim().replace(/^\[|\]$/g, '').toLowerCase()
    const slot = offeredSlots.get(key) ?? [...offeredSlots.values()].find(s => s.start === key.toUpperCase() || sameStart(s.start, given.trim(), offeredZone))
    return slot?.start ?? null
  }
  const notOffered = () =>
    `That is not a time find_slots offered. Use the key in brackets of one of these: ${[...offeredSlots].slice(-6).map(([key, s]) => `${s.label} [${key}]`).join(', ') || 'none yet, call find_slots first'}.`

  /** The day the caller named, worked out from today where the business is; a question or a miss is said back as is. */
  const today = () => todayIn(call.booking?.timeZone ?? 'America/New_York')
  const dayOf = (said: string | null | undefined, end = false): Day | null => (said?.trim() ? resolveDay(said, today(), { end }) : null)
  /** The calendar the model named, else the default one (the prompt lists calendars only when there are several). */
  const calendarOf = (id: string | null | undefined) =>
    id?.trim() || call.booking?.calendars.find(c => c.is_default)?.id || call.booking?.calendars[0]?.id || ''
  const notADay = (day: Day | null) => (day && !('date' in day) ? ('ask' in day ? day.ask : day.unknown) : null)

  async function findSlots(args: FindSlotsArgs): Promise<string> {
    const from = dayOf(args.from_date)
    const to = dayOf(args.to_date, true)
    const unclear = notADay(from) ?? notADay(to)
    if (unclear) return unclear
    try {
      const { data } = await api.run(calendarFindSlots, {
        appointmentTypeId: args.appointment_type_id, calendarId: calendarOf(args.calendar_id), callId, limit: SEARCH_LIMIT,
        ...(from && 'date' in from ? { fromDate: from.date } : {}), ...(to && 'date' in to ? { toDate: to.date } : {}),
      }, call)
      offeredZone = (data as FindSlotsData).timeZone ?? offeredZone
      const offered = spreadSlots((data as FindSlotsData).slots)
      log.record('system', `Checked availability · ${typeName(args.appointment_type_id)} · ${offered.length} slot${offered.length === 1 ? '' : 's'}`, calendarFindSlots.name)
      if (!offered.length) {
        const until = (data as FindSlotsData).bookableUntil
        return `No free times in that range.${until ? ` This appointment can be booked up to ${until} at the latest; say so if the caller asked for a later day.` : ''} Ask whether another day works, or take a message with the times the caller prefers.`
      }
      const listed = offered.map(slot => {
        const key = `s${offeredSlots.size + 1}`
        offeredSlots.set(key, slot)
        return `- ${slot.label} [${key}]`
      })
      return `Free times (offer two or three; book with the key in brackets):\n${listed.join('\n')}\n${SLOT_RULES}\n${zoneRule((data as FindSlotsData).timeZone ?? call.booking?.timeZone ?? "local")}`
    } catch (e) {
      log.record('system', 'Could not check availability', calendarFindSlots.name)
      return `Checking the calendar failed (${failure(e)}). Apologize and take a message with the times the caller prefers.`
    }
  }

  async function book(args: BookArgs): Promise<string> {
    const start = offeredStart(args.start)
    if (!start) return notOffered()
    // Booked already on this call (the model sometimes books again after collecting more details).
    const again = bookedHere.get(start)
    if (again) return `That time is already booked on this call: ${again}. Do not book it again; tell the caller it is booked.`
    // A garbled spoken email made the whole booking fail: ask for it again, or book without it.
    if (args.email?.trim() && !z.email().safeParse(args.email.trim()).success)
      return `"${args.email}" is not a valid email address. Get it with get_email, or book without an email (then there is no confirmation email).`
    try {
      const { data } = await api.run(appointmentBook, {
        appointmentTypeId: args.appointment_type_id, calendarId: calendarOf(args.calendar_id), start, reason: args.reason,
        ...(args.caller_name?.trim() ? { callerName: args.caller_name.trim() } : {}),
        ...(args.address ? { address: args.address } : {}), ...(args.email?.trim() ? { callerEmail: args.email.trim() } : {}), callId, ...(call.assistant ? { assistantId: call.assistant.id } : {}),
      }, call)
      const booked = data as BookData
      const what = `${typeName(args.appointment_type_id)}, ${booked.label}`
      bookedHere.set(start, what)
      log.bookings.push(what)
      log.record('system', `Booked · ${what} · ${booked.calendarName}`, appointmentBook.name)
      return `Booked: ${what}. Confirm the day and time to the caller exactly as written here: ${booked.label}.`
    } catch (e) {
      log.record('system', 'Booking failed', appointmentBook.name)
      return `The booking did not go through (${failure(e)}). Do not say it is booked. Offer to look for another time, or take a message.`
    }
  }

  /** Failed attempts to describe a booking on this call: after MAX_DESCRIBE_ATTEMPTS, no more guesses. */
  let failedDescriptions = 0
  /**
   * The name is the one the caller said and confirmed in the name step on this call, never the model's: it knows the
   * contact's name (caller ID, caller history) and once cancelled an appointment before the caller had said any name.
   * Caller ID is cheap to fake, so the name the caller says is the check.
   */
  const described = ({ booking_date }: Pick<DescribedBooking, 'booking_date'>) => ({ bookingDate: booking_date, bookedName: log.confirmedName ?? '', callId })
  const NAME_FIRST =
    "Before you cancel or move an appointment, get the caller's full name with get_name: they say it and confirm it. Never use a name from your notes or the greeting."
  const outOfAttempts = () => failedDescriptions >= MAX_DESCRIBE_ATTEMPTS
  const refused = (e: unknown, what: string) => `${what} did not work (${failure(e)}). Do not guess another day or name: take a message instead.`
  /**
   * The API refused the change: counted as a miss (no match, or locked out), or, with `slotTaken`, the new time
   * is not free any more, which is no miss: the caller picks another one.
   */
  const declined = (data: unknown) => {
    const answer = data as { changed?: boolean; refused?: string; slotTaken?: boolean } | undefined
    if (answer?.changed !== false) return null
    if (answer.slotTaken) return 'That time is not free any more. Look for slots again and offer the caller another time.'
    failedDescriptions++
    return `That did not work (${answer.refused ?? 'no booking matches'}). Do not guess another day, name or time: take a message instead.`
  }
  const NO_MORE = 'The booking could not be found on this call. Do not try again: take a message instead.'

  async function cancel(said: DescribedBooking): Promise<string> {
    if (outOfAttempts()) return NO_MORE
    if (!log.confirmedName) return NAME_FIRST
    const day = dayOf(said.booking_date)
    if (!day || !('date' in day)) return notADay(day) ?? 'Ask the caller which day the appointment is on.'
    const which = { booking_date: day.date }
    try {
      const { data } = await api.run(appointmentCancel, { ...described(which), readsRefusals: true }, call)
      const no = declined(data)
      if (no) {
        log.record('system', 'Could not cancel an appointment', appointmentCancel.name)
        return no
      }
      log.record('system', 'Cancelled an appointment', appointmentCancel.name)
      const label = (data as { label?: string } | undefined)?.label
      return `Cancelled${label ? ` the appointment on ${label}` : ''}. Tell the caller it is cancelled.`
    } catch (e) {
      log.record('system', 'Could not cancel an appointment', appointmentCancel.name)
      return refused(e, 'Cancelling')
    }
  }

  /** `searched`: the appointment type and calendar find_slots was asked with; the API checks the time with them first. */
  async function reschedule(said: DescribedBooking, newStart: string, searched: { appointment_type_id: string; calendar_id?: string | null }): Promise<string> {
    if (outOfAttempts()) return NO_MORE
    if (!log.confirmedName) return NAME_FIRST
    const day = dayOf(said.booking_date)
    if (!day || !('date' in day)) return notADay(day) ?? 'Ask the caller which day the appointment is on.'
    const which = { booking_date: day.date }
    const start = offeredStart(newStart)
    if (!start) return notOffered()
    try {
      const { data } = await api.run(appointmentReschedule, {
        ...described(which), start, appointmentTypeId: searched.appointment_type_id, calendarId: calendarOf(searched.calendar_id),
      }, call)
      const no = declined(data)
      if (no) {
        log.record('system', 'Could not move an appointment', appointmentReschedule.name)
        return no
      }
      const moved = data as BookData
      log.bookings.push(`moved to ${moved.label}`)
      log.record('system', `Rescheduled · ${moved.label} · ${moved.calendarName}`, appointmentReschedule.name)
      return `Moved to ${moved.label}. Confirm the new day and time to the caller.`
    } catch (e) {
      log.record('system', 'Could not move an appointment', appointmentReschedule.name)
      return refused(e, 'Moving it')
    }
  }

  return { findSlots, book, cancel, reschedule }
}
