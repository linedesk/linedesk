// Booking: free slots (working hours, exceptions, appointment type, existing bookings and the
// calendar's busy times at the provider), booking into one of the assistant's calendars, cancelling,
// and the appointment types. Also what call.start tells the agent about booking.
import { type BookData, type BookingContext, type BookingFieldInput, type CallTestFinding, type FindSlotsData, isE164 } from '@linedesk/actions'
import { addDays, type BookWhen, buffersOf, CalendarError, type CalendarProvider, findSlots, type FindSlotsInput, type HoursException, hoursFor, type Interval, type WorkingHours, zonedTimeToInstant } from '@linedesk/calendar'
import {
  appointment_types, assistant_calendars, assistants, availability_exceptions, availability_rules, bookings, calendar_connections, calls, contacts, 
  type AppointmentType, type AssistantCalendar, type BookingField, type Tx, workspace_settings,
} from '@linedesk/db'
import type { Closure } from '@linedesk/db/types'
import { and, asc, eq, gt, gte, inArray, lt, lte, ne, sql } from 'drizzle-orm'
import { WEB_ORIGIN } from './auth.ts'
import { queueBookingConfirmation, queueCallPush } from './jobs.ts'
import { queueWebhookEvent, webhookData } from './webhooks.ts'
import { providerFor } from './calendar-connections.ts'
import type { Actor } from './context.ts'
import { type Handler, type HandlerCtx, Forbidden, lockCall, Reject } from './handler-context.ts'

const DAY_MS = 86_400_000
/** Used until a workspace has stored its own time zone. */
export const DEFAULT_TIME_ZONE = 'America/New_York'
/**
 * Hours the assistant books in when the business has no business hours switched on (or set):
 * Monday to Friday, 9 to 5, in its time zone. Without them a connected calendar would offer nothing, or the middle of the night.
 */
export const DEFAULT_BOOKING_HOURS: WorkingHours[] = [1, 2, 3, 4, 5].map(weekday => ({ weekday, start_time: '09:00', end_time: '17:00' }))

const newId = (prefix: string) => `${prefix}_${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`
const shift = (iso: string, ms: number) => new Date(Date.parse(iso) + ms).toISOString()
const earlier = (a: string, b: string) => (Date.parse(a) <= Date.parse(b) ? a : b)
const later = (a: string, b: string) => (Date.parse(a) >= Date.parse(b) ? a : b)

function workspaceOf(actor: Actor) {
  if (!actor.workspaceId) throw new Reject('no workspace')
  return actor.workspaceId
}

/** "Tuesday, November 17 at 9:00 AM" in the business's time zone. */
export function slotLabel(iso: string, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' })
    .formatToParts(new Date(iso))
  const part = (type: string) => parts.find(p => p.type === type)?.value ?? ''
  return `${part('weekday')}, ${part('month')} ${part('day')} at ${part('hour')}:${part('minute')} ${part('dayPeriod')}`
}

/** slotLabel with the zone's short name, for emails read anywhere: "Tuesday, November 17 at 9:00 AM PST". */
export function slotWithZone(at: Date | string, timeZone: string) {
  const iso = new Date(at).toISOString()
  const zone = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'short' }).formatToParts(new Date(iso)).find(p => p.type === 'timeZoneName')?.value
  return zone ? `${slotLabel(iso, timeZone)} ${zone}` : slotLabel(iso, timeZone)
}

export async function timeZoneOf(tx: Tx, workspaceId: string) {
  const [settings] = await tx.select({ timezone: workspace_settings.timezone }).from(workspace_settings).where(eq(workspace_settings.workspace_id, workspaceId))
  return settings?.timezone ?? DEFAULT_TIME_ZONE
}

/** Bookings that can collide with a slot in `window`, the buffer on both sides included; only the calendar's own when one is given. */
function loadBusy(tx: Tx, workspaceId: string, window: Interval, bufferMin: number, calendarId?: string, excludeBookingId?: string) {
  const bufferMs = bufferMin * 60_000
  return tx.select({ start: bookings.start_at, end: bookings.end_at }).from(bookings).where(and(
    eq(bookings.workspace_id, workspaceId), ne(bookings.status, 'cancelled'),
    calendarId ? eq(bookings.calendar_id, calendarId) : undefined,
    excludeBookingId ? ne(bookings.id, excludeBookingId) : undefined,
    gt(bookings.end_at, shift(window.start, -bufferMs)), lt(bookings.start_at, shift(window.end, bufferMs)),
  ))
}

/** Exceptions on the dates `window` can touch; a day of slack on each side covers every time zone. */
function loadExceptions(tx: Tx, workspaceId: string, window: Interval) {
  const day = (iso: string, days: number) => shift(iso, days * DAY_MS).slice(0, 10)
  return tx.select().from(availability_exceptions).where(and(
    eq(availability_exceptions.workspace_id, workspaceId),
    gte(availability_exceptions.date, day(window.start, -1)), lte(availability_exceptions.date, day(window.end, 1)),
  ))
}

/** The workspace's vacation or closure mode, or null. */
async function closureOf(tx: Tx, workspaceId: string): Promise<Closure | null> {
  const [row] = await tx.select({ closure: workspace_settings.closure }).from(workspace_settings).where(eq(workspace_settings.workspace_id, workspaceId))
  return row?.closure ?? null
}

/** The closure's dates that `window` can touch, as closed days (a day of slack on each side, as for exceptions). */
export function closureDays(closure: Closure | null, window: Interval): HoursException[] {
  if (!closure) return []
  const first = [closure.from, shift(window.start, -DAY_MS).slice(0, 10)].sort().at(-1)!
  const last = [closure.until, shift(window.end, DAY_MS).slice(0, 10)].sort()[0]!
  const days: HoursException[] = []
  for (let date = first; date <= last; date = addDays(date, 1)) days.push({ date, start_time: null, end_time: null })
  return days
}

/** Closure days win over a holiday with its own hours on the same date. */
const withClosure = (exceptions: readonly HoursException[], closed: HoursException[]) => {
  const dates = new Set(closed.map(d => d.date))
  return [...exceptions.filter(e => !dates.has(e.date)), ...closed]
}

/** Stored calendar setup the engine cannot work with is the caller's problem to fix, not a server error. */
function findSlotsOrReject(input: FindSlotsInput) {
  try {
    return findSlots(input)
  } catch (e) {
    if (e instanceof RangeError) throw new Reject(`calendar setup is invalid: ${e.message}`)
    throw e
  }
}

/** An enabled calendar of an assistant of the workspace, whose account is connected, with its adapter. */
async function bookableCalendar(tx: Tx, ctx: Pick<HandlerCtx, 'calendars'>, workspaceId: string, calendarId: string, assistantId?: string) {
  const [calendar] = await tx.select().from(assistant_calendars).where(and(eq(assistant_calendars.id, calendarId), eq(assistant_calendars.workspace_id, workspaceId)))
  if (!calendar || (assistantId && calendar.assistant_id !== assistantId)) throw new Reject("that calendar is not one of the assistant's calendars")
  if (!calendar.enabled) throw new Reject(`${calendar.name} is switched off for booking`)
  const { connection, provider } = await providerFor(tx, ctx, workspaceId, calendar.connection_id)
  if (connection.status !== 'connected') throw new Reject(`the calendar account ${connection.account_email} has to be connected again`)
  return { calendar, provider }
}

/** The provider's answer as a rejection the caller can read; the agent then takes a message instead. */
async function atProvider<T>(request: () => Promise<T>): Promise<T> {
  try {
    return await request()
  } catch (e) {
    if (e instanceof CalendarError) throw new Reject(`the calendar could not be reached: ${e.message}`)
    throw e
  }
}

/** The business hours bookings follow: the workspace's, when they are switched on and set; else null (the default hours apply). */
async function bookingHours(tx: Tx, workspaceId: string): Promise<WorkingHours[] | null> {
  const [settings] = await tx.select({ on: workspace_settings.business_hours_on }).from(workspace_settings).where(eq(workspace_settings.workspace_id, workspaceId))
  if (!settings?.on) return null
  const rules = await tx.select().from(availability_rules).where(eq(availability_rules.workspace_id, workspaceId))
  return rules.length ? rules : null
}

type SlotSearch = {
  type: AppointmentType; window: Interval; now: string; limit: number
  calendar?: { row: AssistantCalendar; provider: CalendarProvider }
  /** A booking being moved: its own time does not count as busy. */
  excludeBookingId?: string
}

/** Free slots: the engine over working hours (or the default ones), exceptions, bookings and the calendar's busy times at the provider. */
async function availableSlots(tx: Tx, workspaceId: string, timeZone: string, { type, window, now, limit, calendar, excludeBookingId }: SlotSearch) {
  if (Date.parse(window.end) <= Date.parse(window.start)) return []
  const rules = await bookingHours(tx, workspaceId)
  const { before, after } = buffersOf(type)
  const buffer = Math.max(before, after) * 60_000
  const [local, remote] = await Promise.all([
    loadBusy(tx, workspaceId, window, Math.max(before, after), calendar?.row.id, excludeBookingId),
    // One request to the provider, over the window and its buffers.
    calendar ? atProvider(() => calendar.provider.busy([calendar.row.external_id], { start: shift(window.start, -buffer), end: shift(window.end, buffer) })) : [],
  ])
  // The type says how it relates to the business hours (yours when switched on, else the default ones).
  // Holidays apply to the default hours too.
  const when = hoursFor(type.book_when, rules ?? DEFAULT_BOOKING_HOURS, await loadExceptions(tx, workspaceId, window))
  return findSlotsOrReject({
    timeZone,
    hours: when.hours,
    // Vacation or closure mode closes its days whatever the type's hours say.
    exceptions: withClosure(when.exceptions, closureDays(await closureOf(tx, workspaceId), window)),
    appointmentType: type,
    busy: [...local, ...remote],
    window,
    now,
    limit,
  }).map(slot => ({ ...slot, label: slotLabel(slot.start, timeZone) }))
}

async function enabledType(tx: Tx, workspaceId: string, id: string) {
  const [type] = await tx.select().from(appointment_types).where(and(eq(appointment_types.id, id), eq(appointment_types.workspace_id, workspaceId)))
  if (!type?.enabled) throw new Reject('appointment type not found')
  return type
}

type FindSlotsArgs = { callId?: string; appointmentTypeId: string; from?: string; to?: string; fromDate?: string; toDate?: string; calendarId?: string; limit: number }
type BookArgs = {
  appointmentTypeId: string; calendarId: string; start: string; callerName?: string; reason: string
  address?: string; callerPhone?: string; callerEmail?: string; callId?: string; assistantId?: string
}

/** Confirmation emails a workspace may send in an hour; the address comes from a caller, so it is capped. */
export const CONFIRMATIONS_PER_HOUR = 20

/**
 * Why a confirmation email must not go out, or null: at most one per call, and at most
 * CONFIRMATIONS_PER_HOUR per workspace. The booking itself is not affected.
 */
async function confirmationLimit(tx: Tx, workspaceId: string, callId: string | null, now: string): Promise<string | null> {
  const queued = and(eq(bookings.workspace_id, workspaceId), eq(bookings.confirmation, 'queued'))
  if (callId) {
    const [sent] = await tx.select({ id: bookings.id }).from(bookings).where(and(queued, eq(bookings.call_id, callId))).limit(1)
    if (sent) return 'this call has had its confirmation email already'
  }
  const [{ count } = { count: 0 }] = await tx.select({ count: sql<number>`count(*)::int` }).from(bookings)
    .where(and(queued, gt(bookings.created_at, shift(now, -3_600_000))))
  return count >= CONFIRMATIONS_PER_HOUR ? `${CONFIRMATIONS_PER_HOUR} confirmation emails in the last hour` : null
}

/** The details the type requires that the booking lacks, as the assistant should ask for them. */
function missingDetails(type: Pick<AppointmentType, 'required_fields' | 'name_required'>, details: { name?: string; phone: string | null; email: string | null; address?: string }) {
  const labels = { name: 'name', phone: 'phone number', email: 'email address', address: 'address' } as const
  return bookingFieldsOf(type).filter(field => !details[field]).map(field => labels[field])
}

/** The details a type asks for, the name first: `name` is its own column (name_required). */
const bookingFieldsOf = (type: Pick<AppointmentType, 'required_fields' | 'name_required'>): BookingFieldInput[] =>
  [...(type.name_required ? (['name'] as const) : []), ...type.required_fields]

/** The type created with a workspace's first calendar (see ensureAppointmentType). */
const DEFAULT_APPOINTMENT_TYPE = { name: 'Appointment', duration_min: 30, instruction: 'no other type fits', name_required: true } as const

/**
 * Gives a workspace without an enabled appointment type a plain 30-minute one, so an assistant that just
 * got a calendar can book at once. Never a second one: the workspace is locked while it looks. Returns
 * the new row, or nothing when the workspace has a type already.
 */
export async function ensureAppointmentType(tx: Tx, workspaceId: string): Promise<AppointmentType[]> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`appointment-types:${workspaceId}`}))`)
  const [existing] = await tx.select({ id: appointment_types.id }).from(appointment_types)
    .where(and(eq(appointment_types.workspace_id, workspaceId), eq(appointment_types.enabled, true))).limit(1)
  if (existing) return []
  return tx.insert(appointment_types).values({ id: newId('at'), workspace_id: workspaceId, ...DEFAULT_APPOINTMENT_TYPE }).returning()
}

type TypeInput = {
  appointmentTypeId?: string; name: string; durationMin: number; bufferMin?: number; bufferBeforeMin?: number; bufferAfterMin?: number
  bookWhen?: BookWhen; minNoticeHours?: number; maxDaysAhead?: number; enabled?: boolean; requiredFields?: BookingFieldInput[]; instruction?: string
}

/**
 * The buffer columns an upsert sets: the two buffers (bufferMin, from callers before them, sets both),
 * and buffer_min as the larger one, for a release that only knows buffer_min. Nothing when none is given.
 */
function buffersFrom(input: TypeInput, existing?: AppointmentType) {
  const before = input.bufferBeforeMin ?? input.bufferMin
  const after = input.bufferAfterMin ?? input.bufferMin
  if (before === undefined && after === undefined) return {}
  const buffer_before_min = before ?? existing?.buffer_before_min ?? 0
  const buffer_after_min = after ?? existing?.buffer_after_min ?? 0
  return { buffer_before_min, buffer_after_min, buffer_min: Math.max(buffer_before_min, buffer_after_min) }
}

type WhichBooking = { bookingId?: string; callId?: string; bookingDate?: string; bookedName?: string }
type CancelInput = WhichBooking & { readsRefusals?: boolean }
type RescheduleInput = WhichBooking & { start: string; appointmentTypeId?: string; calendarId?: string }
type CallRow = typeof calls.$inferSelect
type BookingRow = typeof bookings.$inferSelect
type HandlerResult = Awaited<ReturnType<Handler>>

/**
 * Failed tries a caller has in 24 hours, over all their calls, to describe a booking to change. At the limit, booking changes by phone stop for that caller and the call is
 * flagged urgent for the team: nobody can guess days and names call after call.
 */
export const BOOKING_MISSES_PER_DAY = 3
export const NO_MATCHING_BOOKING = 'no booking of this caller matches that day and name: take a message instead'
export const BOOKING_CHANGES_LOCKED = 'booking changes by phone are switched off for this caller for now: take a message instead, the team will call back'
export const TIME_NOT_FREE = 'That time is not free: look for slots again.'
/** The next step the team finds on the call that reached the limit. */
export const BOOKING_MISSES_NOTE = 'Several tries on the phone to change a booking did not match. Check with the caller before changing anything.'

/** The words of a name, lower case, letters and digits only: "O'Neil, Sam" and "sam oneil" have the same words. */
const nameWords = (name: string) => name.toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}\s]/gu, '').split(/\s+/).filter(Boolean)

/** The caller's name on a booking: its title is "<type> · <caller name>". */
export const bookedNameOf = (title: string | null) => (title?.includes(' · ') ? title.slice(title.lastIndexOf(' · ') + 3) : '')

/** Whether what the caller said is the name on the booking: every word of it, in any order, and nothing else. */
export function namesMatch(stated: string, booked: string) {
  const said = new Set(nameWords(stated))
  const onBooking = nameWords(booked)
  return onBooking.length > 0 && onBooking.every(word => said.has(word)) && [...said].every(word => onBooking.includes(word))
}

/** The caller's misses over their calls of the last 24 hours: by contact, or by number for a caller without one. */
export async function recentBookingMisses(tx: Tx, workspaceId: string, caller: { contact_id: string | null; from_number: string }, now: string) {
  const who = caller.contact_id ? eq(calls.contact_id, caller.contact_id) : eq(calls.from_number, caller.from_number)
  const [row] = await tx.select({ misses: sql<number>`coalesce(sum(${calls.booking_misses}), 0)::int` }).from(calls)
    .where(and(eq(calls.workspace_id, workspaceId), who, gt(calls.started_at, shift(now, -DAY_MS))))
  return row?.misses ?? 0
}

/**
 * A refused change, counted as a miss on the call. The action succeeds (data `changed: false`), so the miss is
 * kept; the one that reaches the limit flags the call urgent, with a note for the team.
 */
async function refuseAsMiss(tx: Tx, call: CallRow, now: string, refused = NO_MATCHING_BOOKING): Promise<HandlerResult> {
  const misses = (await recentBookingMisses(tx, call.workspace_id, call, now)) + 1
  const reachedLimit = misses === BOOKING_MISSES_PER_DAY
  const [updated] = await tx.update(calls).set({
    booking_misses: sql`${calls.booking_misses} + 1`,
    ...(reachedLimit ? { urgency: 'urgent' as const, action_items: [...call.action_items, { text: BOOKING_MISSES_NOTE }] } : {}),
  }).where(eq(calls.id, call.id)).returning()
  if (reachedLimit && call.urgency !== 'urgent' && call.source !== 'test') await queueCallPush(tx, call.id, 'urgent')
  return { rows: { calls: [updated!] }, data: { changed: false, refused: misses >= BOOKING_MISSES_PER_DAY ? BOOKING_CHANGES_LOCKED : refused } }
}

/**
 * The call the agent changes a booking on, once it may try: the caller described the booking, has a number,
 * and is not locked out. Returns the refusal instead when locked out (nothing is counted then).
 */
async function describingCaller(tx: Tx, workspaceId: string, input: WhichBooking, now: string): Promise<{ call: CallRow } | { refused: HandlerResult }> {
  if (!input.callId) throw new Forbidden('the assistant can only change a booking on a call')
  const [call] = await tx.select().from(calls).where(and(eq(calls.id, input.callId), eq(calls.workspace_id, workspaceId)))
  if (!call) throw new Reject('call not found')
  if (!input.bookingDate || !input.bookedName) throw new Reject('ask the caller for the day of the appointment and the name it is booked under')
  if (!call.contact_id) throw new Reject('this caller cannot change bookings by phone (no caller number): take a message instead')
  // One caller's changes run one at a time until their transaction ends, so two calls at once cannot both pass
  // the check below before either counts its miss.
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`booking-misses:${workspaceId}:${call.contact_id}`}))`)
  if ((await recentBookingMisses(tx, workspaceId, call, now)) >= BOOKING_MISSES_PER_DAY) {
    return { refused: { rows: {}, data: { changed: false, refused: BOOKING_CHANGES_LOCKED } } }
  }
  return { call }
}

/** The one upcoming booking of the call's caller on the day described whose name matches, or null. */
async function describedBooking(tx: Tx, workspaceId: string, call: CallRow, input: WhichBooking, now: string): Promise<BookingRow | null> {
  const timeZone = await timeZoneOf(tx, workspaceId)
  const dayStart = new Date(zonedTimeToInstant(input.bookingDate!, '00:00', timeZone)).toISOString()
  const dayEnd = new Date(zonedTimeToInstant(input.bookingDate!, '24:00', timeZone)).toISOString()
  const candidates = await tx.select().from(bookings).where(and(
    eq(bookings.workspace_id, workspaceId), eq(bookings.contact_id, call.contact_id!), ne(bookings.status, 'cancelled'),
    gt(bookings.start_at, now), gte(bookings.start_at, dayStart), lt(bookings.start_at, dayEnd),
  ))
  const matching = candidates.filter(b => namesMatch(input.bookedName!, bookedNameOf(b.title)))
  // Nothing that day, another name, or more than one match: all the same miss, no hint for someone guessing.
  return matching.length === 1 ? matching[0]! : null
}

/**
 * A booking named by id. A member may change any of the workspace's, and with a call only one of that call's
 * caller; the agent only one booked on this very call (the call test cleans up after itself this way).
 */
async function bookingById(tx: Tx, actor: Actor, workspaceId: string, input: WhichBooking): Promise<BookingRow> {
  if (actor.role === 'agent' && !input.callId) throw new Forbidden('the assistant can only change a booking on a call')
  if (!input.bookingId) throw new Reject('bookingId is required')
  const [booking] = await tx.select().from(bookings).where(and(eq(bookings.id, input.bookingId), eq(bookings.workspace_id, workspaceId)))
  if (actor.role === 'agent') {
    if (!booking || booking.call_id !== input.callId) throw new Reject('describe the booking by its day and name instead')
  } else {
    if (!booking) throw new Reject('booking not found')
    const [call] = input.callId
      ? await tx.select({ contact_id: calls.contact_id }).from(calls).where(and(eq(calls.id, input.callId), eq(calls.workspace_id, workspaceId)))
      : []
    if (input.callId && !call) throw new Reject('call not found')
    if (call && (!call.contact_id || booking.contact_id !== call.contact_id)) throw new Reject("that booking is not the caller's")
  }
  if (booking.status === 'cancelled') throw new Reject('that booking is cancelled already')
  return booking
}

/** The calendar a booking's event is in, with its adapter; null when the calendar was removed since. */
async function calendarOfBooking(tx: Tx, ctx: Pick<HandlerCtx, 'calendars'>, workspaceId: string, calendarId: string | null) {
  const [calendar] = calendarId
    ? await tx.select().from(assistant_calendars).where(and(eq(assistant_calendars.id, calendarId), eq(assistant_calendars.workspace_id, workspaceId)))
    : []
  if (!calendar) return null
  const { provider } = await providerFor(tx, ctx, workspaceId, calendar.connection_id)
  return { calendar, provider }
}

/** Bookings the assistant makes on one call: each one writes a real calendar event and a webhook. */
export const BOOKINGS_PER_CALL = 2
const LINK_REMOVED = '[link removed]'
/** Links: with a scheme or "www.", or a bare domain with a path or a common top-level domain. */
const LINK = /\b(?:[a-z][a-z0-9+.-]*:\/\/|www\.)\S+|\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:[a-z]{2,24}\/\S*|(?:com|net|org|info|biz|io|co|app|dev|xyz|top|site|online|link|click|me|us|ru|cn|tk|ly|gl|to|sh)\b)/gi

/**
 * The reason without links: it is what the caller said, and it lands in the business's calendar, where a link
 * would look like the business's own note.
 */
export const withoutLinks = (text: string) => text.replace(LINK, LINK_REMOVED)

/** The event text the business sees in its calendar. */
function eventDescription({ reason, phone, address, callId }: { reason: string; phone: string | null; address?: string; callId?: string }) {
  return [
    withoutLinks(reason),
    phone ? `Phone: ${phone}` : null,
    address ? `Address: ${address}` : null,
    callId ? `Call: ${new URL(`/#call/${callId}`, WEB_ORIGIN)}` : null,
    'Booked by the Linedesk assistant.',
  ].filter(Boolean).join('\n')
}

/**
 * After the agent found the booking the caller described, whatever stops the change (type switched off, the
 * calendar refusing, the time not free for it) would tell the caller the booking exists. The change runs in a
 * savepoint, and a refusal rolls it back and is counted as the same miss as no match.
 */
async function changeOrMiss(tx: Tx, call: CallRow, now: string, change: (sp: Tx) => Promise<HandlerResult>): Promise<HandlerResult> {
  try {
    return await tx.transaction(change)
  } catch (e) {
    if (e instanceof Reject) return refuseAsMiss(tx, call, now)
    throw e
  }
}

/** Cancels a booking and deletes its event; the calendar is asked last, so if it refuses the booking stays as it was. */
async function cancelBooking(tx: Tx, ctx: Pick<HandlerCtx, 'calendars'>, workspaceId: string, booking: BookingRow): Promise<HandlerResult> {
  const rows = await tx.update(bookings).set({ status: 'cancelled' }).where(eq(bookings.id, booking.id)).returning()
  const at = await calendarOfBooking(tx, ctx, workspaceId, booking.calendar_id)
  if (at && booking.external_event_id) await atProvider(() => at.provider.deleteEvent(at.calendar.external_id, booking.external_event_id!))
  const timeZone = await timeZoneOf(tx, workspaceId)
  return { rows: { bookings: rows }, data: { changed: true, eventDeleted: Boolean(at && booking.external_event_id), label: slotLabel(new Date(booking.start_at).toISOString(), timeZone) } }
}

/**
 * Moves a booking and its event to `startAt`: same checks as booking, with the booking's own time not counting
 * as busy; the event moves last.
 */
async function moveBooking(tx: Tx, ctx: Pick<HandlerCtx, 'calendars'>, workspaceId: string, booking: BookingRow, startAt: string, now: string): Promise<HandlerResult> {
  const at = await calendarOfBooking(tx, ctx, workspaceId, booking.calendar_id)
  if (!at || !booking.external_event_id) throw new Reject('that booking has no calendar event to move')
  if (!booking.appointment_type_id) throw new Reject('that booking has no appointment type')
  const type = await enabledType(tx, workspaceId, booking.appointment_type_id)
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`booking:${at.calendar.id}`}))`)
  const timeZone = await timeZoneOf(tx, workspaceId)
  const start = new Date(startAt).toISOString()
  const end = shift(start, type.duration_min * 60_000)
  const own = { start: new Date(booking.start_at).toISOString(), end: new Date(booking.end_at).toISOString() }
  const provider: CalendarProvider = {
    ...at.provider,
    busy: async (ids, window) => (await at.provider.busy(ids, window)).filter(b => b.start !== own.start || b.end !== own.end),
  }
  const free = await availableSlots(tx, workspaceId, timeZone, {
    type, window: { start, end }, now, limit: 1, calendar: { row: at.calendar, provider }, excludeBookingId: booking.id,
  })
  if (free[0]?.start !== start) throw new Reject(TIME_NOT_FREE)
  const rows = await tx.update(bookings).set({ start_at: start, end_at: end, status: 'rescheduled' }).where(eq(bookings.id, booking.id)).returning()
  await atProvider(() => at.provider.updateEvent(at.calendar.external_id, booking.external_event_id!, { start, end }))
  const data: BookData & { changed: true } = { changed: true, bookingId: booking.id, start, end, label: slotLabel(start, timeZone), calendarName: at.calendar.name }
  return { rows: { bookings: rows }, data }
}

export const bookingHandlers: Record<string, Handler> = {
  'calendar.findSlots': async ({ tx, actor, now, ...ctx }, input: FindSlotsArgs) => {
    const workspaceId = workspaceOf(actor)
    const type = await enabledType(tx, workspaceId, input.appointmentTypeId)
    const timeZone = await timeZoneOf(tx, workspaceId)
    // On a call only the calendars of the assistant that answered it (an agent of the release before sends no call).
    const [call] = input.callId ? await tx.select({ assistant_id: calls.assistant_id }).from(calls).where(and(eq(calls.id, input.callId), eq(calls.workspace_id, workspaceId))) : []
    if (input.callId && !call) throw new Reject('call not found')
    const calendar = input.calendarId ? await bookableCalendar(tx, ctx, workspaceId, input.calendarId, call?.assistant_id ?? undefined) : undefined
    // Nothing is bookable after the horizon, so nothing is loaded for it either.
    const horizon = shift(now, (type.max_days_ahead + 1) * DAY_MS)
    const from = input.from ?? (input.fromDate ? new Date(zonedTimeToInstant(input.fromDate, '00:00', timeZone)).toISOString() : now)
    const to = input.to ?? (input.toDate ? new Date(zonedTimeToInstant(input.toDate, '24:00', timeZone)).toISOString() : horizon)
    const window = { start: later(from, now), end: earlier(to, horizon) }
    const slots = await availableSlots(tx, workspaceId, timeZone, { type, window, now, limit: input.limit, calendar: calendar && { row: calendar.calendar, provider: calendar.provider } })
    return { rows: {}, data: { appointmentTypeId: type.id, timeZone, slots } satisfies FindSlotsData }
  },

  // The slot is checked again right before the event is written, under a lock per calendar, so two
  // calls cannot book the same time. The event is written last; if the booking row then fails, it is deleted.
  'appointment.book': async ({ tx, actor, now, onRollback, ...ctx }, input: BookArgs) => {
    const workspaceId = workspaceOf(actor)
    const type = await enabledType(tx, workspaceId, input.appointmentTypeId)
    if (input.callId) await lockCall(tx, input.callId)
    const [call] = input.callId ? await tx.select().from(calls).where(and(eq(calls.id, input.callId), eq(calls.workspace_id, workspaceId))) : []
    if (input.callId && !call) throw new Reject('call not found')
    if (call && actor.role === 'agent') {
      const [made] = await tx.select({ n: sql<number>`count(*)::int` }).from(bookings).where(eq(bookings.call_id, call.id))
      if ((made?.n ?? 0) >= BOOKINGS_PER_CALL) throw new Reject(`${BOOKINGS_PER_CALL} appointments are booked on this call already: take a message for anything more`)
    }
    // On a call, the assistant that answered it decides which calendars may be used.
    if (call?.assistant_id && input.assistantId && call.assistant_id !== input.assistantId) throw new Reject("that calendar is not one of the assistant's calendars")
    const { calendar, provider } = await bookableCalendar(tx, ctx, workspaceId, input.calendarId, call?.assistant_id ?? input.assistantId)
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`booking:${calendar.id}`}))`)

    const timeZone = await timeZoneOf(tx, workspaceId)
    const start = new Date(input.start).toISOString()
    const end = shift(start, type.duration_min * 60_000)
    const free = await availableSlots(tx, workspaceId, timeZone, { type, window: { start, end }, now, limit: 1, calendar: { row: calendar, provider } })
    if (free[0]?.start !== start) throw new Reject('That time is not free any more: look for slots again.')

    // A withheld caller ID ("anonymous") is no phone number to put on a booking.
    const phone = input.callerPhone ?? (isE164(call?.from_number) ? call.from_number : null)
    const [contact] = call?.contact_id ? await tx.select({ email: contacts.email, name: contacts.name }).from(contacts).where(eq(contacts.id, call.contact_id)) : []
    const email = input.callerEmail ?? contact?.email ?? null
    const missing = missingDetails(type, { name: input.callerName, phone, email, address: input.address })
    if (missing.length) throw new Reject(`A ${type.name} needs the caller's ${missing.join(' and ')}: ask for it, then book.`)
    const title = input.callerName ? `${type.name} · ${input.callerName}` : type.name
    const event = await atProvider(() => provider.createEvent(calendar.external_id, {
      title, start, end, location: input.address, description: eventDescription({ reason: input.reason, phone, address: input.address, callId: call?.id }),
    }))
    onRollback?.(async () => {
      await provider.deleteEvent(calendar.external_id, event.id)
      return 'the calendar event was deleted again'
    })
    const skipped = email ? await confirmationLimit(tx, workspaceId, call?.id ?? null, now) : null
    if (skipped) console.warn(`booking confirmation for workspace ${workspaceId} skipped: ${skipped}`)
    const confirmation = email ? (skipped ? 'skipped' : 'queued') : null
    const rows = await tx.insert(bookings).values({
      id: newId('bk'), workspace_id: workspaceId, call_id: call?.id ?? null, contact_id: call?.contact_id ?? null, appointment_type_id: type.id,
      start_at: start, end_at: end, calendar_id: calendar.id, external_event_id: event.id, title, calendar_name: calendar.name, caller_email: email, address: input.address ?? null,
      confirmation,
    }).returning()
    // The confirmation email goes out after the booking committed (a job), so a slow mail server never holds up the call.
    if (confirmation === 'queued') await queueBookingConfirmation(tx, rows[0]!.id)
    if (call?.source !== 'test') await queueWebhookEvent(tx, workspaceId, 'booking.created', webhookData.bookingCreated(rows[0]!), now)
    // The name the caller gave goes on their contact too, unless it has one.
    const named = input.callerName && call?.contact_id && !contact?.name
      ? await tx.update(contacts).set({ name: input.callerName }).where(eq(contacts.id, call.contact_id)).returning()
      : []
    const data: BookData = { bookingId: rows[0]!.id, start, end, label: slotLabel(start, timeZone), calendarName: calendar.name }
    return { rows: { bookings: rows, ...(named.length && { contacts: named }) }, data }
  },

  // The agent describes the booking (day and name, describedBooking); a member names it by id.
  'appointment.cancel': async ({ tx, actor, now, ...ctx }, input: CancelInput) => {
    const workspaceId = workspaceOf(actor)
    if (actor.role !== 'agent' || input.bookingId) return cancelBooking(tx, ctx, workspaceId, await bookingById(tx, actor, workspaceId, input))
    // An agent of the release before this one reads any answer as cancelled: a plain refusal, before anything else.
    if (!input.readsRefusals) throw new Reject('this assistant must be updated to change bookings: take a message instead')
    const caller = await describingCaller(tx, workspaceId, input, now)
    if ('refused' in caller) return caller.refused
    const booking = await describedBooking(tx, workspaceId, caller.call, input, now)
    if (!booking) return refuseAsMiss(tx, caller.call, now)
    return changeOrMiss(tx, caller.call, now, sp => cancelBooking(sp, ctx, workspaceId, booking))
  },

  // The agent's new time is checked first, with the type and calendar it searched: a time that is not free then
  // says nothing about any booking and is not a miss. Every refusal after that is (refuseAsMiss).
  'appointment.reschedule': async ({ tx, actor, now, ...ctx }, input: RescheduleInput) => {
    const workspaceId = workspaceOf(actor)
    if (actor.role !== 'agent' || input.bookingId) return moveBooking(tx, ctx, workspaceId, await bookingById(tx, actor, workspaceId, input), input.start, now)
    // An agent of the release before this one sends neither and reads any answer as moved: a plain refusal, before
    // anything else, so it takes a message (the agent may be older than the API while an update rolls out).
    if (!input.appointmentTypeId || !input.calendarId) throw new Reject('pass the appointment type and calendar find_slots was asked with')
    const caller = await describingCaller(tx, workspaceId, input, now)
    if ('refused' in caller) return caller.refused
    const { call } = caller
    const type = await enabledType(tx, workspaceId, input.appointmentTypeId)
    const searched = await bookableCalendar(tx, ctx, workspaceId, input.calendarId, call.assistant_id ?? undefined)
    // Locked before the check, as moveBooking locks it: nobody books the time between the check and the move.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`booking:${searched.calendar.id}`}))`)
    const start = new Date(input.start).toISOString()
    const free = await availableSlots(tx, workspaceId, await timeZoneOf(tx, workspaceId), {
      type, window: { start, end: shift(start, type.duration_min * 60_000) }, now, limit: 1, calendar: { row: searched.calendar, provider: searched.provider },
    })
    // Taken since the caller heard it (or never offered): says nothing about a booking, so not a miss.
    if (free[0]?.start !== start) return { rows: {}, data: { changed: false, refused: TIME_NOT_FREE, slotTaken: true } }
    const booking = await describedBooking(tx, workspaceId, call, input, now)
    if (!booking) return refuseAsMiss(tx, call, now)
    return changeOrMiss(tx, call, now, sp => moveBooking(sp, ctx, workspaceId, booking, input.start, now))
  },

  'appointmentType.upsert': async ({ tx, actor }, input: TypeInput) => {
    const workspace_id = workspaceOf(actor)
    const scope = input.appointmentTypeId ? and(eq(appointment_types.id, input.appointmentTypeId), eq(appointment_types.workspace_id, workspace_id)) : undefined
    const [existing] = scope ? await tx.select().from(appointment_types).where(scope) : []
    if (scope && !existing) throw new Reject('appointment type not found')
    const values = {
      name: input.name, duration_min: input.durationMin,
      ...buffersFrom(input, existing),
      ...(input.bookWhen !== undefined && { book_when: input.bookWhen }),
      ...(input.minNoticeHours !== undefined && { min_notice_hours: input.minNoticeHours }),
      ...(input.maxDaysAhead !== undefined && { max_days_ahead: input.maxDaysAhead }),
      ...(input.enabled !== undefined && { enabled: input.enabled }),
      ...(input.requiredFields !== undefined && {
        name_required: input.requiredFields.includes('name'),
        required_fields: [...new Set(input.requiredFields.filter((f): f is BookingField => f !== 'name'))],
      }),
      ...(input.instruction !== undefined && { instruction: input.instruction }),
    }
    if (!input.appointmentTypeId) {
      return { rows: { appointment_types: await tx.insert(appointment_types).values({ id: newId('at'), workspace_id, ...values }).returning() } }
    }
    return { rows: { appointment_types: await tx.update(appointment_types).set(values).where(scope).returning() } }
  },

  'appointmentType.delete': async ({ tx, actor }, input: { appointmentTypeId: string }) => {
    const workspace_id = workspaceOf(actor)
    const scope = and(eq(appointment_types.id, input.appointmentTypeId), eq(appointment_types.workspace_id, workspace_id))
    const [type] = await tx.select().from(appointment_types).where(scope)
    if (!type) throw new Reject('appointment type not found')
    const [used] = await tx.select({ id: bookings.id }).from(bookings).where(eq(bookings.appointment_type_id, type.id)).limit(1)
    if (used) return { rows: { appointment_types: await tx.update(appointment_types).set({ enabled: false }).where(scope).returning() }, data: { deleted: false } }
    await tx.delete(appointment_types).where(scope)
    return { rows: {}, deleted: { appointment_types: [type.id] }, data: { deleted: true } }
  },
}

/**
 * What the agent needs to book on a call: the appointment types and the assistant's enabled
 * calendars of connected accounts, with today's date where the business is. null when either is missing.
 * `contactId`: the caller's contact, only for a caller with a dialable number; booking changes need one, and
 * are off for a caller who reached BOOKING_MISSES_PER_DAY.
 */
export async function bookingContext(tx: Tx, workspaceId: string, now: string, { contactId, assistantId }: { contactId?: string | null; assistantId?: string | null } = {}): Promise<BookingContext | null> {
  const typeRows = await tx.select({
    id: appointment_types.id, name: appointment_types.name, duration_min: appointment_types.duration_min, required_fields: appointment_types.required_fields,
    name_required: appointment_types.name_required, instruction: appointment_types.instruction,
  }).from(appointment_types)
    .where(and(eq(appointment_types.workspace_id, workspaceId), eq(appointment_types.enabled, true))).orderBy(asc(appointment_types.created_at))
  if (!typeRows.length) return null
  const types = typeRows.map(t => ({ id: t.id, name: t.name, duration_min: t.duration_min, required_fields: bookingFieldsOf(t), instruction: t.instruction }))
  const calendars = await tx.select({ id: assistant_calendars.id, name: assistant_calendars.name, instruction: assistant_calendars.instruction, is_default: assistant_calendars.is_default })
    .from(assistant_calendars)
    .innerJoin(calendar_connections, eq(calendar_connections.id, assistant_calendars.connection_id))
    .innerJoin(assistants, eq(assistants.id, assistant_calendars.assistant_id))
    .where(and(
      eq(assistant_calendars.workspace_id, workspaceId), eq(assistant_calendars.enabled, true), eq(calendar_connections.status, 'connected'),
      assistantId ? eq(assistant_calendars.assistant_id, assistantId) : undefined,
    ))
    .orderBy(asc(assistant_calendars.created_at))
  if (!calendars.length) return null
  const timeZone = await timeZoneOf(tx, workspaceId)
  const today = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }).format(new Date(now))
  const todayDate = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now))
  // The caller's bookings are never listed: caller ID is not proof of who calls. A caller with a number
  // may change one by saying its day and name, which the API checks (changeableBooking).
  const locked = contactId ? (await recentBookingMisses(tx, workspaceId, { contact_id: contactId, from_number: '' }, now)) >= BOOKING_MISSES_PER_DAY : true
  return { timeZone, today, todayDate, appointmentTypes: types, calendars, upcoming: [], canChangeBookings: !locked }
}

/** For the call test: the call's bookings and whether each event exists at the provider now. */
export async function bookingsForTest(tx: Tx, ctx: Pick<HandlerCtx, 'calendars'>, workspaceId: string, callId: string): Promise<NonNullable<CallTestFinding['bookings']>> {
  const rows = await tx.select().from(bookings).where(and(eq(bookings.workspace_id, workspaceId), eq(bookings.call_id, callId))).orderBy(asc(bookings.created_at))
  const calendarIds = rows.map(b => b.calendar_id).filter((id): id is string => !!id)
  const calendars = calendarIds.length ? await tx.select().from(assistant_calendars).where(inArray(assistant_calendars.id, calendarIds)) : []
  return Promise.all(rows.map(async booking => {
    const calendar = calendars.find(c => c.id === booking.calendar_id)
    const base = {
      id: booking.id, status: booking.status, start_at: new Date(booking.start_at).toISOString(), title: booking.title, calendar_name: booking.calendar_name,
      calendar_instruction: calendar?.instruction ?? null,
    }
    if (!calendar || !booking.external_event_id) return { ...base, event: 'unchecked' as const, event_start: null, note: 'no calendar event recorded' }
    try {
      const { provider } = await providerFor(tx, ctx, workspaceId, calendar.connection_id)
      const event = await provider.getEvent(calendar.external_id, booking.external_event_id)
      return event && !event.cancelled
        ? { ...base, event: 'found' as const, event_start: event.start, note: null }
        : { ...base, event: 'missing' as const, event_start: null, note: null }
    } catch (e) {
      return { ...base, event: 'unchecked' as const, event_start: null, note: e instanceof Error ? e.message : String(e) }
    }
  }))
}

