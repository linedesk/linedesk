// Booking: free slots (working hours, exceptions, appointment type, existing bookings and the
// calendar's busy times at the provider), booking into one of the assistant's calendars, cancelling,
// and the appointment types. Also what call.start tells the agent about booking.
import type { BookData, BookingContext, CallTestFinding, FindSlotsData } from '@linedesk/actions'
import { CalendarError, type CalendarProvider, findSlots, type FindSlotsInput, type Interval, type WorkingHours, zonedTimeToInstant } from '@linedesk/calendar'
import {
  appointment_types, assistant_calendars, assistants, availability_exceptions, availability_rules, bookings, calendar_connections, calls, contacts, 
  type AppointmentType, type AssistantCalendar, type BookingField, type Tx, workspace_settings,
} from '@linedesk/db'
import { and, asc, eq, gt, gte, inArray, lt, lte, ne, sql } from 'drizzle-orm'
import { WEB_ORIGIN } from './auth.ts'
import { queueBookingConfirmation } from './jobs.ts'
import { providerFor } from './calendar-connections.ts'
import type { Actor } from './context.ts'
import { type Handler, type HandlerCtx, Reject } from './handler-context.ts'

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

async function timeZoneOf(tx: Tx, workspaceId: string) {
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
  const buffer = type.buffer_min * 60_000
  const [local, remote] = await Promise.all([
    loadBusy(tx, workspaceId, window, type.buffer_min, calendar?.row.id, excludeBookingId),
    // One request to the provider, over the window and its buffers.
    calendar ? atProvider(() => calendar.provider.busy([calendar.row.external_id], { start: shift(window.start, -buffer), end: shift(window.end, buffer) })) : [],
  ])
  return findSlotsOrReject({
    timeZone,
    hours: rules ?? DEFAULT_BOOKING_HOURS,
    exceptions: rules ? await loadExceptions(tx, workspaceId, window) : [],
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

type FindSlotsArgs = { appointmentTypeId: string; from?: string; to?: string; fromDate?: string; toDate?: string; calendarId?: string; limit: number }
type BookArgs = {
  appointmentTypeId: string; calendarId: string; start: string; callerName: string; reason: string
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
function missingDetails(type: AppointmentType, details: { phone: string | null; email: string | null; address?: string }) {
  const labels = { phone: 'phone number', email: 'email address', address: 'address' } as const
  return type.required_fields.filter(field => !details[field]).map(field => labels[field])
}

/** A booking the actor may change. On a call only the caller's own; the agent always names its call. */
async function changeableBooking(tx: Tx, actor: Actor, workspaceId: string, bookingId: string, callId?: string) {
  const [booking] = await tx.select().from(bookings).where(and(eq(bookings.id, bookingId), eq(bookings.workspace_id, workspaceId)))
  if (!booking) throw new Reject('booking not found')
  if (actor.role === 'agent' && !callId) throw new Reject('the assistant can only change a booking on a call')
  if (callId) {
    const [call] = await tx.select({ contact_id: calls.contact_id }).from(calls).where(and(eq(calls.id, callId), eq(calls.workspace_id, workspaceId)))
    if (!call) throw new Reject('call not found')
    if (!call.contact_id || booking.contact_id !== call.contact_id) throw new Reject("that booking is not the caller's")
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

/** The event text the business sees in its calendar. */
function eventDescription({ reason, phone, address, callId }: { reason: string; phone: string | null; address?: string; callId?: string }) {
  return [
    reason,
    phone ? `Phone: ${phone}` : null,
    address ? `Address: ${address}` : null,
    callId ? `Call: ${new URL(`/#call/${callId}`, WEB_ORIGIN)}` : null,
    'Booked by the Linedesk assistant.',
  ].filter(Boolean).join('\n')
}

export const bookingHandlers: Record<string, Handler> = {
  'calendar.findSlots': async ({ tx, actor, now, ...ctx }, input: FindSlotsArgs) => {
    const workspaceId = workspaceOf(actor)
    const type = await enabledType(tx, workspaceId, input.appointmentTypeId)
    const timeZone = await timeZoneOf(tx, workspaceId)
    const calendar = input.calendarId ? await bookableCalendar(tx, ctx, workspaceId, input.calendarId) : undefined
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
    const [call] = input.callId ? await tx.select().from(calls).where(and(eq(calls.id, input.callId), eq(calls.workspace_id, workspaceId))) : []
    if (input.callId && !call) throw new Reject('call not found')
    // On a call, the assistant that answered it decides which calendars may be used.
    if (call?.assistant_id && input.assistantId && call.assistant_id !== input.assistantId) throw new Reject("that calendar is not one of the assistant's calendars")
    const { calendar, provider } = await bookableCalendar(tx, ctx, workspaceId, input.calendarId, call?.assistant_id ?? input.assistantId)
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`booking:${calendar.id}`}))`)

    const timeZone = await timeZoneOf(tx, workspaceId)
    const start = new Date(input.start).toISOString()
    const end = shift(start, type.duration_min * 60_000)
    const free = await availableSlots(tx, workspaceId, timeZone, { type, window: { start, end }, now, limit: 1, calendar: { row: calendar, provider } })
    if (free[0]?.start !== start) throw new Reject('That time is not free any more: look for slots again.')

    const phone = input.callerPhone ?? call?.from_number ?? null
    const [contact] = call?.contact_id ? await tx.select({ email: contacts.email }).from(contacts).where(eq(contacts.id, call.contact_id)) : []
    const email = input.callerEmail ?? contact?.email ?? null
    const missing = missingDetails(type, { phone, email, address: input.address })
    if (missing.length) throw new Reject(`A ${type.name} needs the caller's ${missing.join(' and ')}: ask for it, then book.`)
    const title = `${type.name} · ${input.callerName}`
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
      start_at: start, end_at: end, calendar_id: calendar.id, external_event_id: event.id, title, calendar_name: calendar.name, caller_email: email,
      confirmation,
    }).returning()
    // The confirmation email goes out after the booking committed (a job), so a slow mail server never holds up the call.
    if (confirmation === 'queued') await queueBookingConfirmation(tx, rows[0]!.id)
    const data: BookData = { bookingId: rows[0]!.id, start, end, label: slotLabel(start, timeZone), calendarName: calendar.name }
    return { rows: { bookings: rows }, data }
  },

  'appointment.cancel': async ({ tx, actor, ...ctx }, input: { bookingId: string; callId?: string }) => {
    const workspaceId = workspaceOf(actor)
    const booking = await changeableBooking(tx, actor, workspaceId, input.bookingId, input.callId)
    const rows = await tx.update(bookings).set({ status: 'cancelled' }).where(eq(bookings.id, booking.id)).returning()
    // The calendar is asked last: if it refuses, the booking stays as it was.
    const at = await calendarOfBooking(tx, ctx, workspaceId, booking.calendar_id)
    if (at && booking.external_event_id) await atProvider(() => at.provider.deleteEvent(at.calendar.external_id, booking.external_event_id!))
    return { rows: { bookings: rows }, data: { eventDeleted: Boolean(at && booking.external_event_id) } }
  },

  // Same checks as booking, with the booking's own time not counting as busy; the event moves last.
  'appointment.reschedule': async ({ tx, actor, now, ...ctx }, input: { bookingId: string; start: string; callId?: string }) => {
    const workspaceId = workspaceOf(actor)
    const booking = await changeableBooking(tx, actor, workspaceId, input.bookingId, input.callId)
    const at = await calendarOfBooking(tx, ctx, workspaceId, booking.calendar_id)
    if (!at || !booking.external_event_id) throw new Reject('that booking has no calendar event to move')
    if (!booking.appointment_type_id) throw new Reject('that booking has no appointment type')
    const type = await enabledType(tx, workspaceId, booking.appointment_type_id)
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`booking:${at.calendar.id}`}))`)
    const timeZone = await timeZoneOf(tx, workspaceId)
    const start = new Date(input.start).toISOString()
    const end = shift(start, type.duration_min * 60_000)
    const own = { start: new Date(booking.start_at).toISOString(), end: new Date(booking.end_at).toISOString() }
    const provider: CalendarProvider = {
      ...at.provider,
      busy: async (ids, window) => (await at.provider.busy(ids, window)).filter(b => b.start !== own.start || b.end !== own.end),
    }
    const free = await availableSlots(tx, workspaceId, timeZone, {
      type, window: { start, end }, now, limit: 1, calendar: { row: at.calendar, provider }, excludeBookingId: booking.id,
    })
    if (free[0]?.start !== start) throw new Reject('That time is not free: look for slots again.')
    const rows = await tx.update(bookings).set({ start_at: start, end_at: end, status: 'rescheduled' }).where(eq(bookings.id, booking.id)).returning()
    await atProvider(() => at.provider.updateEvent(at.calendar.external_id, booking.external_event_id!, { start, end }))
    const data: BookData = { bookingId: booking.id, start, end, label: slotLabel(start, timeZone), calendarName: at.calendar.name }
    return { rows: { bookings: rows }, data }
  },

  'appointmentType.upsert': async ({ tx, actor }, input: { appointmentTypeId?: string; name: string; durationMin: number; bufferMin?: number; minNoticeHours?: number; maxDaysAhead?: number; enabled?: boolean; requiredFields?: BookingField[] }) => {
    const workspace_id = workspaceOf(actor)
    const values = {
      name: input.name, duration_min: input.durationMin,
      ...(input.bufferMin !== undefined && { buffer_min: input.bufferMin }),
      ...(input.minNoticeHours !== undefined && { min_notice_hours: input.minNoticeHours }),
      ...(input.maxDaysAhead !== undefined && { max_days_ahead: input.maxDaysAhead }),
      ...(input.enabled !== undefined && { enabled: input.enabled }),
      ...(input.requiredFields !== undefined && { required_fields: [...new Set(input.requiredFields)] }),
    }
    if (!input.appointmentTypeId) {
      return { rows: { appointment_types: await tx.insert(appointment_types).values({ id: newId('at'), workspace_id, ...values }).returning() } }
    }
    const rows = await tx.update(appointment_types).set(values)
      .where(and(eq(appointment_types.id, input.appointmentTypeId), eq(appointment_types.workspace_id, workspace_id))).returning()
    if (!rows[0]) throw new Reject('appointment type not found')
    return { rows: { appointment_types: rows } }
  },

  'appointmentType.delete': async ({ tx, actor }, input: { appointmentTypeId: string }) => {
    const workspace_id = workspaceOf(actor)
    const scope = and(eq(appointment_types.id, input.appointmentTypeId), eq(appointment_types.workspace_id, workspace_id))
    const [type] = await tx.select().from(appointment_types).where(scope)
    if (!type) throw new Reject('appointment type not found')
    const [used] = await tx.select({ id: bookings.id }).from(bookings).where(eq(bookings.appointment_type_id, type.id)).limit(1)
    if (used) return { rows: { appointment_types: await tx.update(appointment_types).set({ enabled: false }).where(scope).returning() }, data: { deleted: false } }
    await tx.delete(appointment_types).where(scope)
    return { rows: {}, data: { deleted: true } }
  },
}

/**
 * What the agent needs to book on a call: the appointment types and the assistant's enabled
 * calendars of connected accounts, with today's date where the business is. null when either is missing.
 */
export async function bookingContext(tx: Tx, workspaceId: string, now: string, { contactId, assistantId }: { contactId?: string | null; assistantId?: string | null } = {}): Promise<BookingContext | null> {
  const types = await tx.select({ id: appointment_types.id, name: appointment_types.name, duration_min: appointment_types.duration_min, required_fields: appointment_types.required_fields }).from(appointment_types)
    .where(and(eq(appointment_types.workspace_id, workspaceId), eq(appointment_types.enabled, true))).orderBy(asc(appointment_types.created_at))
  if (!types.length) return null
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
  const upcoming = contactId
    ? (await tx.select().from(bookings)
      .where(and(eq(bookings.workspace_id, workspaceId), eq(bookings.contact_id, contactId), ne(bookings.status, 'cancelled'), gt(bookings.start_at, now)))
      .orderBy(asc(bookings.start_at)).limit(5)).map(b => ({ id: b.id, title: b.title, label: slotLabel(new Date(b.start_at).toISOString(), timeZone) }))
    : []
  return { timeZone, today, todayDate, appointmentTypes: types, calendars, upcoming }
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

