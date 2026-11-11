// Booking: free slots with the calendar's busy times, booking into one of the assistant's calendars,
// cancelling, appointment types, and what the agent learns at call.start. Handlers run with a fake
// calendar provider inside a transaction that is rolled back; permissions and tenancy through the API.
import { actions, rolePermissions } from '@linedesk/actions'
import type { CalendarEventInput, CalendarProvider, Interval } from '@linedesk/calendar'
import { CalendarError } from '@linedesk/calendar'
import { appointment_types, assistant_calendars, assistants, availability_rules, bookings, calls, type Tx, workspace_settings } from '@linedesk/db'
import { eq } from 'drizzle-orm'
import { beforeAll, describe, expect, test } from 'vitest'
import { confirmationEmail } from '../src/booking-confirmation.ts'
import { CONFIRMATIONS_PER_HOUR, DEFAULT_BOOKING_HOURS, slotLabel } from '../src/bookings.ts'
import type { CalendarServices } from '../src/calendar-connections.ts'
import type { Actor } from '../src/context.ts'
import { db } from '../src/db.ts'
import { runHandler, type Undo } from '../src/handlers.ts'
import { act, addMember, agent, createWorkspace, type User, type Workspace } from './helpers.ts'

class Rollback extends Error {}

async function inRollback(body: (tx: Tx) => Promise<void>) {
  await db.transaction(async tx => {
    await body(tx)
    throw new Rollback()
  }).catch(e => {
    if (!(e instanceof Rollback)) throw e
  })
}

/** A calendar in memory: busy intervals, and the events written into it. */
function fakeCalendar(busy: Interval[] = [], { fail }: { fail?: CalendarError } = {}) {
  const events = new Map<string, CalendarEventInput & { calendarId: string }>()
  const busyCalls: { ids: readonly string[]; window: Interval }[] = []
  let next = 0
  const provider: CalendarProvider = {
    name: 'google',
    listCalendars: async () => [],
    busy: async (ids, window) => {
      busyCalls.push({ ids, window })
      if (fail) throw fail
      return [...busy, ...[...events.values()].map(e => ({ start: e.start, end: e.end }))]
    },
    createEvent: async (calendarId, event) => {
      const id = `ev${++next}`
      events.set(id, { ...event, calendarId })
      return { id }
    },
    updateEvent: async (_calendarId, id, change) => void events.set(id, { ...events.get(id)!, ...change }),
    deleteEvent: async (_calendarId, id) => void events.delete(id),
    getEvent: async (_calendarId, id) => {
      const e = events.get(id)
      return e ? { id, title: e.title, start: e.start, end: e.end, cancelled: false } : null
    },
  }
  const services: CalendarServices = { oauth: () => null, provider: () => provider }
  return { services, events, busyCalls }
}

/** A Monday far enough ahead that minimum notice and the horizon never get in the way. */
const MONDAY = (() => {
  const d = new Date(Date.now() + 3 * 86_400_000)
  d.setUTCDate(d.getUTCDate() + ((8 - d.getUTCDay()) % 7))
  return d.toISOString().slice(0, 10)
})()
const ZONE = 'America/Los_Angeles'
/** 9:00 local on MONDAY in Los Angeles (UTC-8 or UTC-7). */
const at = (time: string) => new Date(new Date(`${MONDAY}T${time}:00Z`).getTime() + offsetMs(MONDAY)).toISOString()
function offsetMs(date: string) {
  const probe = new Date(`${date}T12:00:00Z`)
  const local = new Date(probe.toLocaleString('en-US', { timeZone: ZONE }))
  const utc = new Date(probe.toLocaleString('en-US', { timeZone: 'UTC' }))
  return utc.getTime() - local.getTime()
}

let ws: Workspace
let other: Workspace
let member: User
let owner: Actor
let typeId: string

beforeAll(async () => {
  ws = await createWorkspace('Brightwater Plumbing & Heating')
  other = await createWorkspace('Other Business')
  member = await addMember(ws.id, 'member')
  owner = { actorId: ws.owner.userId, role: 'owner', workspaceId: ws.id, permissions: rolePermissions.owner }
  await db.update(workspace_settings).set({ timezone: ZONE }).where(eq(workspace_settings.workspace_id, ws.id))
  typeId = `at_${crypto.randomUUID().slice(0, 8)}`
  await db.insert(appointment_types).values({ id: typeId, workspace_id: ws.id, name: 'Repair visit', duration_min: 60, max_days_ahead: 30 })
})

const run = (tx: Tx, actor: Actor, services: CalendarServices, name: string, input: unknown, undos: Undo[] = []) =>
  runHandler({ tx, actor, now: new Date().toISOString(), calendars: services, onRollback: u => undos.push(u) }, actions.get(name)!, actions.get(name)!.input.parse(input))

const day = () => ({ appointmentTypeId: typeId, fromDate: MONDAY, toDate: MONDAY })
const book = (start: string, extra: Record<string, unknown> = {}) => ({
  appointmentTypeId: typeId, calendarId: ws.assistantCalendar.id, start, callerName: 'Sam Patel', reason: 'Water heater maintenance',
  address: '220 NE Alberta St, Portland', callId: ws.call.id, ...extra,
})

describe('free slots', () => {
  test('without business hours: Monday to Friday 9 to 5 in the business time zone, labelled as the business says them', async () => {
    const { services } = fakeCalendar()
    await inRollback(async tx => {
      const { data } = await run(tx, owner, services, 'calendar.findSlots', { ...day(), calendarId: ws.assistantCalendar.id, limit: 50 })
      const slots = data!.slots as { start: string; label: string }[]
      expect(DEFAULT_BOOKING_HOURS).toHaveLength(5)
      expect(slots[0]!.start).toBe(at('09:00'))
      expect(slots.at(-1)!.start).toBe(at('16:00'))
      expect(slots[0]!.label).toMatch(/^Monday, \w+ \d+ at 9:00 AM$/)
      expect(data!.timeZone).toBe(ZONE)
    })
  })

  test("the calendar's busy times at the provider are left out, with one request for the whole window", async () => {
    const { services, busyCalls } = fakeCalendar([{ start: at('10:00'), end: at('12:00') }])
    await inRollback(async tx => {
      await tx.insert(availability_rules).values({ id: `ar_${crypto.randomUUID().slice(0, 8)}`, workspace_id: ws.id, weekday: 1, start_time: '08:00', end_time: '13:00' })
      const { data } = await run(tx, owner, services, 'calendar.findSlots', { ...day(), calendarId: ws.assistantCalendar.id, limit: 50 })
      expect((data!.slots as { start: string }[]).map(s => s.start)).toEqual([at('08:00'), at('08:30'), at('09:00'), at('12:00')])
      expect(busyCalls).toHaveLength(1)
      expect(busyCalls[0]!.ids).toEqual(['primary'])
    })
  })

  test('a calendar that cannot be reached is a rejection with the reason, so the agent can take a message', async () => {
    const { services } = fakeCalendar([], { fail: new CalendarError('google', 'unavailable', 'check availability took longer than 4000 ms') })
    await inRollback(async tx => {
      await expect(run(tx, owner, services, 'calendar.findSlots', { ...day(), calendarId: ws.assistantCalendar.id })).rejects.toThrow(/could not be reached: Google: check availability took longer/)
    })
  })
})

describe('booking', () => {
  test('writes the event with caller, number, reason and address, and stores the booking on the call', async () => {
    const { services, events } = fakeCalendar()
    await inRollback(async tx => {
      const { rows, data } = await run(tx, agent_(ws.id), services, 'appointment.book', book(at('09:00'), { assistantId: ws.assistant.id }))
      expect(rows.bookings).toMatchObject([{
        workspace_id: ws.id, call_id: ws.call.id, contact_id: ws.contact.id, appointment_type_id: typeId, calendar_id: ws.assistantCalendar.id,
        title: 'Repair visit · Sam Patel', calendar_name: 'Office', status: 'confirmed', external_event_id: 'ev1',
      }])
      expect(data).toMatchObject({ start: at('09:00'), end: at('10:00'), calendarName: 'Office', label: slotLabel(at('09:00'), ZONE) })
      const event = events.get('ev1')!
      expect(event).toMatchObject({ calendarId: 'primary', title: 'Repair visit · Sam Patel', start: at('09:00'), end: at('10:00'), location: '220 NE Alberta St, Portland' })
      expect(event.description).toContain('Water heater maintenance')
      expect(event.description).toContain(`Phone: ${ws.call.from_number}`)
      expect(event.description).toContain(`#call/${ws.call.id}`)
    })
  })

  test('a time that is taken, at the provider or by an earlier booking, is refused', async () => {
    const { services } = fakeCalendar([{ start: at('11:00'), end: at('12:00') }])
    await inRollback(async tx => {
      await expect(run(tx, owner, services, 'appointment.book', book(at('11:00')))).rejects.toThrow(/not free any more/)
      await run(tx, owner, services, 'appointment.book', book(at('09:00')))
      await expect(run(tx, owner, services, 'appointment.book', book(at('09:30')))).rejects.toThrow(/not free any more/)
      // Not on a slot start, or outside hours.
      await expect(run(tx, owner, services, 'appointment.book', book(at('13:10')))).rejects.toThrow(/not free/)
      await expect(run(tx, owner, services, 'appointment.book', book(at('20:00')))).rejects.toThrow(/not free/)
    })
  })

  test("only into an enabled calendar of the assistant's", async () => {
    const { services } = fakeCalendar()
    await inRollback(async tx => {
      await expect(run(tx, owner, services, 'appointment.book', book(at('09:00'), { calendarId: other.assistantCalendar.id }))).rejects.toThrow(/not one of the assistant's calendars/)
      await expect(run(tx, owner, services, 'appointment.book', book(at('09:00'), { assistantId: other.assistant.id }))).rejects.toThrow(/not one of the assistant's calendars/)
      await expect(run(tx, owner, services, 'appointment.book', book(at('09:00'), { callId: other.call.id }))).rejects.toThrow(/call not found/)
      await tx.update(assistant_calendars).set({ enabled: false }).where(eq(assistant_calendars.id, ws.assistantCalendar.id))
      await expect(run(tx, owner, services, 'appointment.book', book(at('09:00')))).rejects.toThrow(/switched off/)
    })
  })

  test('cancelling deletes the event and marks the booking cancelled', async () => {
    const { services, events } = fakeCalendar()
    await inRollback(async tx => {
      const { data } = await run(tx, owner, services, 'appointment.book', book(at('09:00')))
      const { rows } = await run(tx, owner, services, 'appointment.cancel', { bookingId: data!.bookingId })
      expect(rows.bookings).toMatchObject([{ status: 'cancelled' }])
      expect(events.size).toBe(0)
    })
  })

  test('the call test sees the booking and its event at the provider', async () => {
    const { services, events } = fakeCalendar()
    await inRollback(async tx => {
      await run(tx, owner, services, 'appointment.book', book(at('09:00')))
      const finding = await run(tx, agent_(null), services, 'call.findForTest', { to: ws.number, since: '2000-01-01T00:00:00Z', from: ws.call.from_number })
      expect(finding.data).toMatchObject({ bookingReady: true, bookings: [{ event: 'found', event_start: at('09:00'), calendar_name: 'Office', title: 'Repair visit · Sam Patel' }] })
      events.clear()
      const gone = await run(tx, agent_(null), services, 'call.findForTest', { to: ws.number, since: '2000-01-01T00:00:00Z', from: ws.call.from_number })
      expect(gone.data).toMatchObject({ bookings: [{ event: 'missing' }] })
    })
  })

  test("a call answered by one assistant cannot book into another assistant's calendar of the same workspace", async () => {
    const { services } = fakeCalendar()
    await inRollback(async tx => {
      const [second] = await tx.insert(assistants).values({ id: `as_${crypto.randomUUID().slice(0, 8)}`, workspace_id: ws.id, name: 'Sam' }).returning()
      const [call] = await tx.insert(calls).values({ id: `call_${crypto.randomUUID().slice(0, 8)}`, workspace_id: ws.id, contact_id: ws.contact.id, from_number: ws.call.from_number, to_number: ws.number, assistant_id: second!.id }).returning()
      await expect(run(tx, agent_(ws.id), services, 'appointment.book', book(at('09:00'), { callId: call!.id }))).rejects.toThrow(/not one of the assistant's calendars/)
      await expect(run(tx, agent_(ws.id), services, 'appointment.book', book(at('09:00'), { callId: call!.id, assistantId: ws.assistant.id }))).rejects.toThrow(/not one of the assistant's calendars/)
    })
  })

  test('details the type requires must be there; an email address is kept for the confirmation', async () => {
    const { services } = fakeCalendar()
    await inRollback(async tx => {
      await tx.update(appointment_types).set({ required_fields: ['email', 'address'] }).where(eq(appointment_types.id, typeId))
      await expect(run(tx, owner, services, 'appointment.book', book(at('09:00'), { address: undefined }))).rejects.toThrow("A Repair visit needs the caller's email address and address: ask for it, then book.")
      const { rows } = await run(tx, owner, services, 'appointment.book', book(at('09:00'), { callerEmail: 'sam@example.com' }))
      expect(rows.bookings).toMatchObject([{ caller_email: 'sam@example.com' }])
    })
  })

  test('confirmation emails: one per call, and at most 20 per workspace an hour; the bookings themselves go through', async () => {
    const { services } = fakeCalendar()
    await inRollback(async tx => {
      const first = await run(tx, owner, services, 'appointment.book', book(at('09:00'), { callerEmail: 'sam@example.com' }))
      expect(first.rows.bookings).toMatchObject([{ confirmation: 'queued' }])
      const second = await run(tx, owner, services, 'appointment.book', book(at('11:00'), { callerEmail: 'sam@example.com' }))
      expect(second.rows.bookings).toMatchObject([{ confirmation: 'skipped', status: 'confirmed' }])
      // No address, nothing to confirm.
      expect((await run(tx, owner, services, 'appointment.book', book(at('13:00'), { callId: undefined }))).rows.bookings).toMatchObject([{ confirmation: null }])

      await tx.insert(bookings).values(Array.from({ length: CONFIRMATIONS_PER_HOUR - 1 }, (_, i) => ({
        id: `bk_flood_${i}_${crypto.randomUUID().slice(0, 6)}`, workspace_id: ws.id, start_at: at('09:00'), end_at: at('10:00'), status: 'cancelled' as const,
        caller_email: `x${i}@example.com`, confirmation: 'queued' as const,
      })))
      const [other] = await tx.insert(calls).values({ id: `call_${crypto.randomUUID().slice(0, 8)}`, workspace_id: ws.id, contact_id: ws.contact.id, from_number: ws.call.from_number, to_number: ws.number }).returning()
      const capped = await run(tx, owner, services, 'appointment.book', book(at('14:00'), { callId: other!.id, callerEmail: 'next@example.com' }))
      expect(capped.rows.bookings).toMatchObject([{ confirmation: 'skipped' }])
    })
  })

  test("on a call, only the caller's own bookings can be cancelled or moved; the agent must name its call", async () => {
    const { services, events } = fakeCalendar()
    await inRollback(async tx => {
      const { data } = await run(tx, owner, services, 'appointment.book', book(at('09:00')))
      const bookingId = data!.bookingId as string
      const [stranger] = await tx.insert(calls).values({ id: `call_${crypto.randomUUID().slice(0, 8)}`, workspace_id: ws.id, from_number: '+15035550999', to_number: ws.number }).returning()
      await expect(run(tx, agent_(ws.id), services, 'appointment.cancel', { bookingId })).rejects.toThrow(/only change a booking on a call/)
      await expect(run(tx, agent_(ws.id), services, 'appointment.cancel', { bookingId, callId: stranger!.id })).rejects.toThrow(/not the caller's/)
      await expect(run(tx, agent_(ws.id), services, 'appointment.reschedule', { bookingId, start: at('11:00'), callId: stranger!.id })).rejects.toThrow(/not the caller's/)

      const moved = await run(tx, agent_(ws.id), services, 'appointment.reschedule', { bookingId, start: at('09:30'), callId: ws.call.id })
      expect(moved.rows.bookings).toMatchObject([{ start_at: expect.anything(), status: 'rescheduled' }])
      expect(moved.data).toMatchObject({ start: at('09:30'), end: at('10:30') })
      expect([...events.values()][0]).toMatchObject({ start: at('09:30'), end: at('10:30') })

      // The caller's upcoming bookings are what call.start offers the agent.
      const started = await run(tx, agent_(null), services, 'call.start', { from: ws.call.from_number, to: ws.number })
      expect(started.data!.booking).toMatchObject({ upcoming: [{ id: bookingId, title: 'Repair visit · Sam Patel', label: slotLabel(at('09:30'), ZONE) }] })

      await run(tx, agent_(ws.id), services, 'appointment.cancel', { bookingId, callId: ws.call.id })
      expect(events.size).toBe(0)
      await expect(run(tx, agent_(ws.id), services, 'appointment.cancel', { bookingId, callId: ws.call.id })).rejects.toThrow(/cancelled already/)
    })
  })
})

test('the confirmation email: business, type and time, no link', () => {
  const email = confirmationEmail({ business: 'Brightwater Plumbing & Heating', what: 'repair visit', when: 'Tuesday, November 17 at 9:00 AM', minutes: 60 })
  expect(email.subject).toBe('Your repair visit with Brightwater Plumbing & Heating: Tuesday, November 17 at 9:00 AM')
  expect(email.text).toContain('is booked for Tuesday, November 17 at 9:00 AM (60 minutes).')
  expect(email.text).not.toMatch(/https?:/)
})

describe('appointment types', () => {
  test('add, change, and delete; one with bookings is switched off instead', async () => {
    const { services } = fakeCalendar()
    await inRollback(async tx => {
      const added = await run(tx, owner, services, 'appointmentType.upsert', { name: 'Estimate', durationMin: 30 })
      const id = (added.rows.appointment_types as { id: string }[])[0]!.id
      expect(added.rows.appointment_types).toMatchObject([{ name: 'Estimate', duration_min: 30, workspace_id: ws.id, enabled: true }])
      expect((await run(tx, owner, services, 'appointmentType.upsert', { appointmentTypeId: id, name: 'Free estimate', durationMin: 45 })).rows.appointment_types).toMatchObject([{ name: 'Free estimate', duration_min: 45 }])
      expect((await run(tx, owner, services, 'appointmentType.delete', { appointmentTypeId: id })).data).toEqual({ deleted: true })
      await run(tx, owner, services, 'appointment.book', book(at('09:00')))
      expect((await run(tx, owner, services, 'appointmentType.delete', { appointmentTypeId: typeId })).data).toEqual({ deleted: false })
      expect((await tx.select().from(appointment_types).where(eq(appointment_types.id, typeId)))[0]!.enabled).toBe(false)
    })
  })
})

describe('through the API', () => {
  test('call.start tells the agent what it can book: types, calendars with their notes, today in the business time zone', async () => {
    const started = await act(agent(), 'call.start', { from: '+15035550177', to: ws.number })
    expect(started.body.data.booking).toMatchObject({
      timeZone: ZONE, todayDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      appointmentTypes: [{ id: typeId, name: 'Repair visit', duration_min: 60 }],
      calendars: [{ id: ws.assistantCalendar.id, name: 'Office', is_default: true }],
    })
    // No appointment type: nothing to book, the assistant takes messages.
    expect((await act(agent(), 'call.start', { from: '+15035550177', to: other.number })).body.data.booking).toBeNull()
  })

  test('members and the agent may book; types are for owners and admins', async () => {
    for (const name of ['appointment.book', 'appointment.cancel']) {
      expect(actions.get(name)!.permission).toBe('calendar:write')
      for (const role of ['owner', 'admin', 'member', 'agent'] as const) expect(rolePermissions[role]).toContain('calendar:write')
    }
    for (const name of ['appointmentType.upsert', 'appointmentType.delete']) {
      expect((await act(member, name, { appointmentTypeId: typeId, name: 'x', durationMin: 30 })).status, name).toBe(403)
      expect((await act(agent(ws.id), name, { appointmentTypeId: typeId, name: 'x', durationMin: 30 })).status, name).toBe(403)
    }
  })

  test("nothing of another workspace: its types, calendars, bookings and calls", async () => {
    const theirs = `at_${crypto.randomUUID().slice(0, 8)}`
    await db.insert(appointment_types).values({ id: theirs, workspace_id: other.id, name: 'Theirs', duration_min: 30 })
    const [booking] = await db.insert(bookings).values({ id: `bk_${crypto.randomUUID().slice(0, 8)}`, workspace_id: other.id, start_at: at('09:00'), end_at: at('10:00') }).returning()
    expect(await act(ws.owner, 'appointmentType.upsert', { appointmentTypeId: theirs, name: 'Mine now', durationMin: 30 })).toMatchObject({ status: 409 })
    expect(await act(ws.owner, 'appointmentType.delete', { appointmentTypeId: theirs })).toMatchObject({ status: 409 })
    expect(await act(member, 'appointment.cancel', { bookingId: booking!.id })).toMatchObject({ status: 409, body: { error: 'booking not found' } })
    expect(await act(agent(ws.id), 'appointment.book', { ...book(at('09:00')), calendarId: other.assistantCalendar.id })).toMatchObject({ status: 409 })
    expect(await act(agent(ws.id), 'appointment.book', { ...book(at('09:00')), appointmentTypeId: theirs })).toMatchObject({ status: 409, body: { error: 'appointment type not found' } })
    expect((await db.select().from(appointment_types).where(eq(appointment_types.id, theirs)))[0]!.name).toBe('Theirs')
    expect((await db.select().from(bookings).where(eq(bookings.id, booking!.id)))[0]!.status).toBe('confirmed')
    expect(await db.select().from(calls).where(eq(calls.id, other.call.id))).toHaveLength(1)
  })
})

function agent_(workspaceId: string | null): Actor {
  return { actorId: 'agent', role: 'agent', workspaceId, permissions: rolePermissions.agent }
}
