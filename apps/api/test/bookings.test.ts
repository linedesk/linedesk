// Booking: free slots with the calendar's busy times, booking into one of the assistant's calendars,
// cancelling, appointment types, and what the agent learns at call.start. Handlers run with a fake
// calendar provider inside a transaction that is rolled back; permissions and tenancy through the API.
import { actions, isE164, normalizeCallerId, rolePermissions } from '@linedesk/actions'
import type { CalendarEventInput, CalendarProvider, Interval } from '@linedesk/calendar'
import { CalendarError } from '@linedesk/calendar'
import { appointment_types, assistant_calendars, assistants, availability_rules, bookings, calls, contacts, phone_numbers, type Tx, webhook_deliveries, webhook_endpoints, workspace_settings } from '@linedesk/db'
import { and, eq } from 'drizzle-orm'
import { beforeAll, describe, expect, test } from 'vitest'
import {
  BOOKING_CHANGES_LOCKED, BOOKING_MISSES_NOTE, BOOKING_MISSES_PER_DAY, BOOKINGS_PER_CALL, bookedNameOf, CONFIRMATIONS_PER_HOUR, DEFAULT_BOOKING_HOURS,
  namesMatch, NO_MATCHING_BOOKING, slotLabel, TIME_NOT_FREE, withoutLinks,
} from '../src/bookings.ts'
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


/** Ends the workspace's live calls, so a test that opens many in a row stays under the calls-at-once limit (LIVE_CALLS_PER_WORKSPACE). */
const endLiveCalls = (tx: Tx, workspaceId: string) =>
  tx.update(calls).set({ status: 'completed' }).where(and(eq(calls.workspace_id, workspaceId), eq(calls.status, 'live')))

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

  test('business hours count only when they are switched on', async () => {
    const { services } = fakeCalendar()
    await inRollback(async tx => {
      await tx.insert(availability_rules).values({ id: `ar_${crypto.randomUUID().slice(0, 8)}`, workspace_id: ws.id, weekday: 1, start_time: '13:00', end_time: '15:00' })
      const starts = async () => ((await run(tx, owner, services, 'calendar.findSlots', { ...day(), calendarId: ws.assistantCalendar.id, limit: 50 })).data!.slots as { start: string }[]).map(s => s.start)
      expect((await starts())[0]).toBe(at('09:00'))
      await tx.update(workspace_settings).set({ business_hours_on: true }).where(eq(workspace_settings.workspace_id, ws.id))
      expect(await starts()).toEqual([at('13:00'), at('13:30'), at('14:00')])
    })
  })

  test("the calendar's busy times at the provider are left out, with one request for the whole window", async () => {
    const { services, busyCalls } = fakeCalendar([{ start: at('10:00'), end: at('12:00') }])
    await inRollback(async tx => {
      await tx.update(workspace_settings).set({ business_hours_on: true }).where(eq(workspace_settings.workspace_id, ws.id))
      await tx.insert(availability_rules).values({ id: `ar_${crypto.randomUUID().slice(0, 8)}`, workspace_id: ws.id, weekday: 1, start_time: '08:00', end_time: '13:00' })
      const { data } = await run(tx, owner, services, 'calendar.findSlots', { ...day(), calendarId: ws.assistantCalendar.id, limit: 50 })
      expect((data!.slots as { start: string }[]).map(s => s.start)).toEqual([at('08:00'), at('08:30'), at('09:00'), at('12:00')])
      expect(busyCalls).toHaveLength(1)
      expect(busyCalls[0]!.ids).toEqual(['primary'])
    })
  })

  test("the type's buffers keep a gap after and before the calendar's events", async () => {
    const { services } = fakeCalendar([{ start: at('10:00'), end: at('12:00') }])
    await inRollback(async tx => {
      await tx.update(workspace_settings).set({ business_hours_on: true }).where(eq(workspace_settings.workspace_id, ws.id))
      await tx.insert(availability_rules).values({ id: `ar_${crypto.randomUUID().slice(0, 8)}`, workspace_id: ws.id, weekday: 1, start_time: '08:00', end_time: '14:00' })
      const starts = async () => ((await run(tx, owner, services, 'calendar.findSlots', { ...day(), calendarId: ws.assistantCalendar.id, limit: 50 })).data!.slots as { start: string }[]).map(s => s.start)
      const set = (bufferBeforeMin: number, bufferAfterMin: number) =>
        run(tx, owner, services, 'appointmentType.upsert', { appointmentTypeId: typeId, name: 'Repair visit', durationMin: 60, bufferBeforeMin, bufferAfterMin })
      const changed = await set(30, 0)
      expect(changed.rows.appointment_types).toMatchObject([{ buffer_before_min: 30, buffer_after_min: 0, buffer_min: 30 }])
      expect(await starts()).toEqual([at('08:00'), at('08:30'), at('09:00'), at('12:30'), at('13:00')])
      await set(0, 30)
      expect(await starts()).toEqual([at('08:00'), at('08:30'), at('12:00'), at('12:30'), at('13:00')])
    })
  })

  test('a type booked only outside business hours: no slots inside them, and booking inside them is refused', async () => {
    const { services } = fakeCalendar()
    await inRollback(async tx => {
      await tx.update(workspace_settings).set({ business_hours_on: true }).where(eq(workspace_settings.workspace_id, ws.id))
      await tx.insert(availability_rules).values({ id: `ar_${crypto.randomUUID().slice(0, 8)}`, workspace_id: ws.id, weekday: 1, start_time: '08:00', end_time: '13:00' })
      await run(tx, owner, services, 'appointmentType.upsert', { appointmentTypeId: typeId, name: 'Repair visit', durationMin: 60, bookWhen: 'outside_business_hours' })
      const { data } = await run(tx, owner, services, 'calendar.findSlots', { ...day(), calendarId: ws.assistantCalendar.id, limit: 50 })
      const starts = (data!.slots as { start: string }[]).map(s => s.start)
      expect(starts).toContain(at('13:00'))
      expect(starts.filter(s => s >= at('07:30') && s < at('13:00'))).toEqual([])
      await expect(run(tx, owner, services, 'appointment.book', book(at('09:00')))).rejects.toThrow(/not free/)
      expect((await run(tx, owner, services, 'appointment.book', book(at('14:00')))).rows.bookings).toHaveLength(1)
      // Any time: inside the hours again too.
      await run(tx, owner, services, 'appointmentType.upsert', { appointmentTypeId: typeId, name: 'Repair visit', durationMin: 60, bookWhen: 'any_time' })
      expect((await run(tx, owner, services, 'appointment.book', book(at('09:00')))).rows.bookings).toHaveLength(1)
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
  test('sends no webhook of its own: the after-call webhook carries the call\'s bookings', async () => {
    const { services } = fakeCalendar()
    await inRollback(async tx => {
      await tx.update(webhook_endpoints).set({ hooks: ['call_end'], status: 'active' }).where(eq(webhook_endpoints.id, ws.webhookEndpoint.id))
      await run(tx, owner, services, 'appointment.book', book(at('09:00')))
      expect(await tx.select().from(webhook_deliveries).where(eq(webhook_deliveries.workspace_id, ws.id))).toEqual([])
    })
  })

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

  test("find_slots on a call looks only in the calendars of the assistant that answered it", async () => {
    const { services } = fakeCalendar()
    await inRollback(async tx => {
      const [second] = await tx.insert(assistants).values({ id: `as_${crypto.randomUUID().slice(0, 8)}`, workspace_id: ws.id, name: 'Sam' }).returning()
      const [call] = await tx.insert(calls).values({ id: `call_${crypto.randomUUID().slice(0, 8)}`, workspace_id: ws.id, contact_id: ws.contact.id, from_number: ws.call.from_number, to_number: ws.number, assistant_id: second!.id }).returning()
      const search = (callId?: string) => run(tx, agent_(ws.id), services, 'calendar.findSlots', { ...day(), calendarId: ws.assistantCalendar.id, ...(callId ? { callId } : {}) })
      await expect(search(call!.id)).rejects.toThrow(/not one of the assistant's calendars/)
      expect((await search(ws.call.id)).data!.slots).not.toHaveLength(0)
      await expect(search('call_nope')).rejects.toThrow('call not found')
    })
  })

  test(`the assistant books at most ${BOOKINGS_PER_CALL} appointments on one call; a member is not limited`, async () => {
    const { services } = fakeCalendar()
    await inRollback(async tx => {
      await run(tx, agent_(ws.id), services, 'appointment.book', book(at('09:00')))
      await run(tx, agent_(ws.id), services, 'appointment.book', book(at('11:00')))
      await expect(run(tx, agent_(ws.id), services, 'appointment.book', book(at('13:00')))).rejects.toThrow(`${BOOKINGS_PER_CALL} appointments are booked on this call already`)
      expect((await run(tx, owner, services, 'appointment.book', book(at('13:00')))).rows.bookings).toHaveLength(1)
    })
  })

  test('links in the reason do not reach the calendar', async () => {
    const { services, events } = fakeCalendar()
    await inRollback(async tx => {
      await run(tx, agent_(ws.id), services, 'appointment.book', book(at('09:00'), { reason: 'Leak, see https://evil.example/pay and www.evil.example or evil.com/x or pay-here.xyz now' }))
      const description = [...events.values()][0]!.description!
      expect(description).toContain('Leak, see [link removed] and [link removed] or [link removed] or [link removed] now')
      expect(description).not.toMatch(/evil|pay-here/)
    })
    expect(withoutLinks('Water heater maintenance, 2 p.m. at No. 5')).toBe('Water heater maintenance, 2 p.m. at No. 5')
  })

  test('HTML links and bare domains in the name, address and reason do not reach the calendar', async () => {
    const { services, events } = fakeCalendar()
    await inRollback(async tx => {
      await run(tx, agent_(ws.id), services, 'appointment.book', book(at('09:00'), {
        callerName: 'Sam <a href="https://evil.example">Pay</a>',
        address: '12 Oak St, deposit at pay-deposit.shop',
        reason: 'Leak. <a href="https://evil.example/pay">Pay the deposit</a> or pay-deposit.shop/now or 10.0.0.1/pay <b',
      }))
      const event = [...events.values()][0]!
      const text = [event.title, event.location, event.description].join('\n')
      expect(text).not.toMatch(/evil|pay-deposit|10\.0\.0\.1|<|href/)
      expect(event.description).toContain('Leak. Pay the deposit or [link removed] or [link removed]')
      expect(event.location).toBe('12 Oak St, deposit at [link removed]')
    })
  })

  test('withoutLinks keeps ordinary text: times, abbreviations, prices, addresses', () => {
    for (const text of ['Costs $3.50, version 2.5, e.g. after 9 a.m.', '123 Main St., Portland, OR 97201', 'St. Johns Heating', 'Müller-Lüdenscheid'])
      expect(withoutLinks(text)).toBe(text)
    expect(withoutLinks('Mail sam@evil.example')).toBe('Mail sam@[link removed]')
    expect(withoutLinks('Café zürich.ünï')).toBe('Café [link removed]')
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

  test('the name is a detail like the others: required unless the type does without it; it names the contact that has none', async () => {
    const { services } = fakeCalendar()
    await inRollback(async tx => {
      await tx.update(contacts).set({ name: null }).where(eq(contacts.id, ws.contact.id))
      await expect(
        run(tx, owner, services, 'appointment.book', book(at('09:00'), { callerName: undefined })),
      ).rejects.toThrow("A Repair visit needs the caller's name: ask for it, then book.")
      const named = await run(tx, owner, services, 'appointment.book', book(at('09:00')))
      expect(named.rows.bookings).toMatchObject([{ title: 'Repair visit · Sam Patel' }])
      expect(named.rows.contacts).toMatchObject([{ id: ws.contact.id, name: 'Sam Patel' }])
      // A contact that has a name keeps it.
      expect(
        (await run(tx, owner, services, 'appointment.book', book(at('11:00'), { callerName: 'Sammy' }))).rows.contacts,
      ).toBeUndefined()

      await run(tx, owner, services, 'appointmentType.upsert', {
        appointmentTypeId: typeId,
        name: 'Repair visit',
        durationMin: 60,
        requiredFields: ['address'],
      })
      const unnamed = await run(tx, owner, services, 'appointment.book', book(at('14:00'), { callerName: undefined }))
      expect(unnamed.rows.bookings).toMatchObject([{ title: 'Repair visit' }])
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

  test("a member names the booking by id; with a call, only that call's caller's", async () => {
    const { services } = fakeCalendar()
    await inRollback(async tx => {
      const { data } = await run(tx, owner, services, 'appointment.book', book(at('09:00')))
      const bookingId = data!.bookingId as string
      const [stranger] = await tx.insert(calls).values({ id: `call_${crypto.randomUUID().slice(0, 8)}`, workspace_id: ws.id, from_number: '+15035550999', to_number: ws.number }).returning()
      await expect(run(tx, owner, services, 'appointment.cancel', { bookingId, callId: stranger!.id })).rejects.toThrow(/not the caller's/)
      await expect(run(tx, owner, services, 'appointment.cancel', {})).rejects.toThrow(/bookingId is required/)
      await run(tx, owner, services, 'appointment.cancel', { bookingId })
      await expect(run(tx, owner, services, 'appointment.cancel', { bookingId })).rejects.toThrow(/cancelled already/)
    })
  })

  test('the agent changes a booking only as the caller describes it: the day and the full name on it, both checked here', async () => {
    const { services, events } = fakeCalendar()
    await inRollback(async tx => {
      await run(tx, owner, services, 'appointment.book', book(at('09:00')))
      // A later call of the same caller (same number, so the same contact): no booking id is known on it.
      const callId = (await callFrom(tx, services, ws.call.from_number)).callId
      const described = (extra: Record<string, unknown>) => ({ callId, bookingDate: MONDAY, bookedName: 'Sam Patel', readsRefusals: true, ...extra })

      await expect(run(tx, agent_(ws.id), services, 'appointment.cancel', { readsRefusals: true, bookingDate: MONDAY, bookedName: 'Sam Patel' })).rejects.toThrow(/only change a booking on a call/)
      await expect(run(tx, agent_(ws.id), services, 'appointment.cancel', { readsRefusals: true, callId })).rejects.toThrow(/ask the caller for the day/)
      // By id only a booking made on this very call.
      const [booked] = await tx.select().from(bookings).where(eq(bookings.call_id, ws.call.id))
      await expect(run(tx, agent_(ws.id), services, 'appointment.cancel', { bookingId: booked!.id, callId })).rejects.toThrow(/describe the booking by its day and name/)
      // The agent must say which type and calendar it searched the new time with.
      await expect(run(tx, agent_(ws.id), services, 'appointment.reschedule', described({ start: at('09:30') }))).rejects.toThrow(/appointment type and calendar/)

      // Spelled, ordered and cased differently, it is still the name on the booking.
      const moved = await run(tx, agent_(ws.id), services, 'appointment.reschedule', described({ bookedName: 'patel, sam', start: at('11:00'), ...searched() }))
      expect(moved.rows.bookings).toMatchObject([{ status: 'rescheduled' }])
      expect(moved.data).toMatchObject({ changed: true })
      expect([...events.values()][0]).toMatchObject({ start: at('11:00'), end: at('12:00') })

      const cancelled = await run(tx, agent_(ws.id), services, 'appointment.cancel', described({}))
      expect(cancelled.data).toEqual({ changed: true, eventDeleted: true, label: slotLabel(at('11:00'), ZONE) })
      expect(events.size).toBe(0)
    })
  })

  test('every refusal is the same miss: wrong name, surname only, wrong day, another caller, two matches', async () => {
    let { services } = fakeCalendar()
    await inRollback(async tx => {
      await run(tx, owner, services, 'appointment.book', book(at('09:00')))
      const { callId } = await callFrom(tx, services, ws.call.from_number)
      const cancel = (extra: Record<string, unknown>) =>
        run(tx, agent_(ws.id), services, 'appointment.cancel', { readsRefusals: true, callId, bookingDate: MONDAY, bookedName: 'Sam Patel', ...extra })
      for (const wrong of [{ bookedName: 'Alex Patel' }, { bookedName: 'Patel' }]) {
        const refused = await cancel(wrong)
        expect(refused.data, JSON.stringify(wrong)).toEqual({ changed: false, refused: NO_MATCHING_BOOKING })
        expect(refused.rows.bookings).toBeUndefined()
      }
      expect(await missesOf(tx, callId)).toBe(2)
      // Another caller who names the same day and name is not this caller (a miss on their call).
      const other = await callFrom(tx, services, '+15035550998')
      expect((await cancel({ callId: other.callId })).data).toEqual({ changed: false, refused: NO_MATCHING_BOOKING })
      expect(await missesOf(tx, other.callId)).toBe(1)
    })
    ;({ services } = fakeCalendar())
    await inRollback(async tx => {
      // Two bookings of the caller under the same name on that day: no way to tell which, so a miss too.
      await run(tx, owner, services, 'appointment.book', book(at('09:00')))
      await run(tx, owner, services, 'appointment.book', book(at('13:00')))
      const { callId } = await callFrom(tx, services, ws.call.from_number)
      const refused = await run(tx, agent_(ws.id), services, 'appointment.cancel', { readsRefusals: true, callId, bookingDate: MONDAY, bookedName: 'Sam Patel' })
      expect(refused.data).toEqual({ changed: false, refused: NO_MATCHING_BOOKING })
      expect(await missesOf(tx, callId)).toBe(1)
    })
    ;({ services } = fakeCalendar())
    await inRollback(async tx => {
      await run(tx, owner, services, 'appointment.book', book(at('09:00')))
      const { callId } = await callFrom(tx, services, ws.call.from_number)
      const refused = await run(tx, agent_(ws.id), services, 'appointment.cancel', { readsRefusals: true, callId, bookingDate: shiftDay(MONDAY, 1), bookedName: 'Sam Patel' })
      expect(refused.data).toEqual({ changed: false, refused: NO_MATCHING_BOOKING })
    })
  })

  test('the new time is checked before the booking is looked for: a taken time answers the same with or without a booking, and is no miss', async () => {
    const { services } = fakeCalendar([{ start: at('14:00'), end: at('15:00') }])
    await inRollback(async tx => {
      await run(tx, owner, services, 'appointment.book', book(at('09:00')))
      const { callId } = await callFrom(tx, services, ws.call.from_number)
      const move = (bookedName: string, start: string) =>
        run(tx, agent_(ws.id), services, 'appointment.reschedule', { callId, bookingDate: MONDAY, bookedName, start, ...searched() })
      // The right booking and a stranger's guess get the same answer for a time that is not free.
      const taken = { changed: false, refused: TIME_NOT_FREE, slotTaken: true }
      expect((await move('Sam Patel', at('14:00'))).data).toEqual(taken)
      expect((await move('Nobody Here', at('14:00'))).data).toEqual(taken)
      // Taken since find_slots (someone booked it in between): the caller picks another time, nothing is counted.
      await run(tx, owner, services, 'appointment.book', book(at('11:00'), { callerName: 'Alex Kim' }))
      expect((await move('Sam Patel', at('11:00'))).data).toEqual(taken)
      expect(await missesOf(tx, callId)).toBe(0)
      expect((await move('Sam Patel', at('13:00'))).data).toMatchObject({ changed: true })
    })
  })

  test('an agent of the release before (no readsRefusals) gets a plain refusal on cancel, never `changed: false`', async () => {
    const { services, events } = fakeCalendar()
    await inRollback(async tx => {
      await run(tx, owner, services, 'appointment.book', book(at('09:00')))
      const { callId } = await callFrom(tx, services, ws.call.from_number)
      await expect(run(tx, agent_(ws.id), services, 'appointment.cancel', { callId, bookingDate: MONDAY, bookedName: 'Sam Patel' }))
        .rejects.toThrow(/must be updated/)
      expect(events.size).toBe(1)
      expect(await missesOf(tx, callId)).toBe(0)
    })
  })

  test(`after ${BOOKING_MISSES_PER_DAY} misses in a day, over any of the caller's calls, booking changes stop and the team is told`, async () => {
    const { services, events } = fakeCalendar()
    await inRollback(async tx => {
      await run(tx, owner, services, 'appointment.book', book(at('09:00')))
      const guess = (callId: string, bookedName: string) =>
        run(tx, agent_(ws.id), services, 'appointment.cancel', { readsRefusals: true, callId, bookingDate: MONDAY, bookedName })
      // Two misses on one call, the third on the next call: the limit counts calls together.
      const first = await callFrom(tx, services, ws.call.from_number)
      await guess(first.callId, 'Guess One')
      await guess(first.callId, 'Guess Two')
      const second = await callFrom(tx, services, ws.call.from_number)
      expect(second.booking).toMatchObject({ canChangeBookings: true })
      const third = await guess(second.callId, 'Guess Three')
      expect(third.data).toEqual({ changed: false, refused: BOOKING_CHANGES_LOCKED })
      expect(third.rows.calls).toMatchObject([{ urgency: 'urgent', booking_misses: 1, action_items: [{ text: BOOKING_MISSES_NOTE }] }])

      // Now even the right day and name change nothing, and nothing more is counted.
      expect((await guess(second.callId, 'Sam Patel')).data).toEqual({ changed: false, refused: BOOKING_CHANGES_LOCKED })
      // An agent of the release before (no type and calendar on reschedule) reads any answer as moved: still a plain refusal.
      await expect(run(tx, agent_(ws.id), services, 'appointment.reschedule', { callId: second.callId, bookingDate: MONDAY, bookedName: 'Sam Patel', start: at('11:00') }))
        .rejects.toThrow(/appointment type and calendar/)
      expect(await missesOf(tx, second.callId)).toBe(1)
      expect(events.size).toBe(1)
      // The next call is not offered changes at all.
      expect((await callFrom(tx, services, ws.call.from_number)).booking).toMatchObject({ canChangeBookings: false })
      // Another caller is not affected.
      expect((await callFrom(tx, services, '+15035550998')).booking).toMatchObject({ canChangeBookings: true })

      // The assistant's own next steps at the end of the call do not replace the note for the team.
      const finished = await run(tx, agent_(ws.id), services, 'call.finish', { callId: second.callId, outcome: 'callback', actionItems: [{ text: 'Call Sam back' }] })
      expect(finished.rows.calls).toMatchObject([{ action_items: [{ text: 'Call Sam back' }, { text: BOOKING_MISSES_NOTE }] }])

      // Misses older than a day no longer count.
      await tx.update(calls).set({ started_at: new Date(Date.now() - 25 * 3_600_000).toISOString() }).where(eq(calls.contact_id, ws.contact.id))
      expect((await callFrom(tx, services, ws.call.from_number)).booking).toMatchObject({ canChangeBookings: true })
    })
  })

  test('after a match, whatever stops the change is the same miss as no match, and the booking stays as it was', async () => {
    const { services, events } = fakeCalendar()
    const refusing = (method: 'deleteEvent' | 'updateEvent'): CalendarServices => ({
      ...services,
      provider: (name, token) => ({
        ...services.provider(name, token),
        [method]: async () => { throw new CalendarError('google', 'unavailable', 'calendar down') },
      }),
    })
    await inRollback(async tx => {
      await run(tx, owner, services, 'appointment.book', book(at('09:00')))
      const { callId } = await callFrom(tx, services, ws.call.from_number)
      const which = { readsRefusals: true, callId, bookingDate: MONDAY, bookedName: 'Sam Patel' }

      // The calendar refuses to delete the event: not cancelled, counted, and said like no match.
      const cancel = await run(tx, agent_(ws.id), refusing('deleteEvent'), 'appointment.cancel', which)
      expect(cancel.data).toEqual({ changed: false, refused: NO_MATCHING_BOOKING })
      // The calendar refuses to move it: the booking keeps its time.
      const move = await run(tx, agent_(ws.id), refusing('updateEvent'), 'appointment.reschedule', { ...which, start: at('11:00'), ...searched() })
      expect(move.data).toEqual({ changed: false, refused: NO_MATCHING_BOOKING })
      const [kept] = await tx.select().from(bookings).where(eq(bookings.call_id, ws.call.id))
      expect(kept!.status).toBe('confirmed')
      expect(Date.parse(kept!.start_at)).toBe(Date.parse(at('09:00')))
      expect([...events.values()][0]).toMatchObject({ start: at('09:00') })
      expect(await missesOf(tx, callId)).toBe(2)
    })
  })

  test("a booking whose appointment type was switched off since cannot be changed by phone: a miss, said like no match", async () => {
    const { services } = fakeCalendar()
    await inRollback(async tx => {
      const oldType = `at_${crypto.randomUUID().slice(0, 8)}`
      await tx.insert(appointment_types).values({ id: oldType, workspace_id: ws.id, name: 'Old visit', duration_min: 60, max_days_ahead: 30 })
      await run(tx, owner, services, 'appointment.book', book(at('09:00'), { appointmentTypeId: oldType }))
      await tx.update(appointment_types).set({ enabled: false }).where(eq(appointment_types.id, oldType))
      const { callId } = await callFrom(tx, services, ws.call.from_number)
      const moved = await run(tx, agent_(ws.id), services, 'appointment.reschedule', { callId, bookingDate: MONDAY, bookedName: 'Sam Patel', start: at('11:00'), ...searched() })
      expect(moved.data).toEqual({ changed: false, refused: NO_MATCHING_BOOKING })
      expect(await missesOf(tx, callId)).toBe(1)
    })
  })

  test('two calls of one caller at once cannot both pass the miss check: one reaches the limit, the other is locked out', async () => {
    const { services } = fakeCalendar()
    const from = '+15035550777'
    const { callId: first } = await db.transaction(tx => callFrom(tx, services, from))
    const { callId: second } = await db.transaction(tx => callFrom(tx, services, from))
    await db.update(calls).set({ booking_misses: BOOKING_MISSES_PER_DAY - 1 }).where(eq(calls.id, first))
    const guess = (tx: Tx, callId: string) => run(tx, agent_(ws.id), services, 'appointment.cancel', { readsRefusals: true, callId, bookingDate: MONDAY, bookedName: 'Nobody Here' })
    // The first call's miss is counted but not committed yet when the second call tries.
    let commitFirst!: () => void
    let firstCounted!: () => void
    const counted = new Promise<void>(resolve => { firstCounted = resolve })
    const firstDone = db.transaction(async tx => {
      const answer = await guess(tx, first)
      firstCounted()
      await new Promise<void>(resolve => { commitFirst = resolve })
      return answer
    })
    await counted
    let secondSettled = false
    const secondDone = db.transaction(tx => guess(tx, second)).finally(() => { secondSettled = true })
    await new Promise(resolve => setTimeout(resolve, 300))
    expect(secondSettled).toBe(false)
    commitFirst()
    const answers = await Promise.all([firstDone, secondDone])
    expect(answers.map(a => a.data)).toEqual([
      { changed: false, refused: BOOKING_CHANGES_LOCKED }, { changed: false, refused: BOOKING_CHANGES_LOCKED },
    ])
    const rows = await db.select({ misses: calls.booking_misses, urgency: calls.urgency }).from(calls).where(eq(calls.from_number, from))
    expect(rows.reduce((sum, r) => sum + r.misses, 0)).toBe(BOOKING_MISSES_PER_DAY)
    expect(rows.filter(r => r.urgency === 'urgent')).toHaveLength(1)
  })

  test("call.start never tells the agent the caller's bookings; booking changes only for a caller with a number", async () => {
    const { services } = fakeCalendar()
    await inRollback(async tx => {
      await run(tx, owner, services, 'appointment.book', book(at('09:00')))
      const known = await run(tx, agent_(null), services, 'call.start', { from: ws.call.from_number, to: ws.number })
      expect(known.data!.booking).toMatchObject({ upcoming: [], canChangeBookings: true })
      expect(JSON.stringify(known.data)).not.toContain('Sam Patel')
    })
  })

  test('a withheld or malformed caller ID gets no contact, no booking changes, and is never the phone number on a booking', async () => {
    const { services, events } = fakeCalendar()
    await inRollback(async tx => {
      for (const from of ['anonymous', 'Restricted', '12345', '+0123456789', 'sip:alice@example.test']) {
        await endLiveCalls(tx, ws.id)
        const started = await run(tx, agent_(null), services, 'call.start', { from, to: ws.number })
        expect(started.data, from).toMatchObject({ contact: null, isNewContact: false, blocked: false, booking: { canChangeBookings: false, upcoming: [] } })
        expect(started.rows.contacts, from).toBeUndefined()
        const [call] = await tx.select().from(calls).where(eq(calls.id, started.data!.callId as string))
        expect(call, from).toMatchObject({ contact_id: null, from_number: from })
        await expect(run(tx, agent_(ws.id), services, 'appointment.cancel', { readsRefusals: true, callId: call!.id, bookingDate: MONDAY, bookedName: 'Sam Patel' })).rejects.toThrow(/no caller number/)
      }
      // Anonymous callers do not share a contact (there is none).
      expect(await tx.select().from(contacts).where(eq(contacts.phone, 'anonymous'))).toEqual([])

      const anonymous = await run(tx, agent_(null), services, 'call.start', { from: 'anonymous', to: ws.number })
      await run(tx, agent_(ws.id), services, 'appointment.book', book(at('11:00'), { callId: anonymous.data!.callId }))
      const event = [...events.values()][0]!
      expect(event.description).not.toContain('Phone:')
      expect(event.description).not.toContain('anonymous')
    })
  })

  test('numbers a carrier sends without "+", as 10 digits or with punctuation are the same caller, and reach the dialled number', async () => {
    const { services } = fakeCalendar()
    await inRollback(async tx => {
      const e164 = ws.call.from_number
      const national = e164.slice(2)
      for (const from of [e164.slice(1), national, `(${national.slice(0, 3)}) ${national.slice(3, 6)}-${national.slice(6)}`, `00${e164.slice(1)}`]) {
        await endLiveCalls(tx, ws.id)
        const started = await run(tx, agent_(null), services, 'call.start', { from, to: ws.number.slice(1) })
        expect(started.data, from).toMatchObject({ isNewContact: false, contact: { id: ws.contact.id }, booking: { canChangeBookings: true } })
        const [call] = await tx.select().from(calls).where(eq(calls.id, started.data!.callId as string))
        expect(call, from).toMatchObject({ from_number: e164, to_number: ws.number, contact_id: ws.contact.id })
      }
    })
  })

  test('ten digits are a US number only on a call to a +1 number', async () => {
    const { services } = fakeCalendar()
    await inRollback(async tx => {
      const uk = '+447700900555'
      await tx.insert(phone_numbers).values({ id: `pn_${crypto.randomUUID().slice(0, 8)}`, workspace_id: ws.id, e164: uk, provider: 'dev' })
      const national = ws.call.from_number.slice(2)
      const started = await run(tx, agent_(null), services, 'call.start', { from: national, to: uk })
      const [call] = await tx.select().from(calls).where(eq(calls.id, started.data!.callId as string))
      expect(call).toMatchObject({ from_number: national, to_number: uk, contact_id: null })
    })
  })
})

test('caller IDs as E.164', () => {
  expect(normalizeCallerId('+15035550123')).toBe('+15035550123')
  expect(normalizeCallerId('15035550123')).toBe('+15035550123')
  expect(normalizeCallerId('9715550123', { nationalUs: true })).toBe('+19715550123')
  expect(normalizeCallerId('9715550123')).toBe('9715550123')
  expect(normalizeCallerId('19715550123')).toBe('+19715550123')
  expect(normalizeCallerId('+1 (503) 555-0123')).toBe('+15035550123')
  expect(normalizeCallerId('503.555.0123', { nationalUs: true })).toBe('+15035550123')
  expect(normalizeCallerId('00447700900123')).toBe('+447700900123')
  // Not numbers, or not ones that can be read without guessing: unchanged, and not E.164.
  for (const raw of ['anonymous', 'Restricted', '12345', '1035550123', '447700900123', '+0123456789', '']) {
    expect(normalizeCallerId(raw, { nationalUs: true }), raw).toBe(raw.trim())
    expect(isE164(normalizeCallerId(raw, { nationalUs: true })), raw).toBe(false)
  }
})

test('the name on a booking: every word of it, in any order, and nothing else', () => {
  expect(bookedNameOf('Repair visit · Sam Patel')).toBe('Sam Patel')
  expect(bookedNameOf('Estimate · Mary-Ann · Lee')).toBe('Lee')
  expect(bookedNameOf(null)).toBe('')
  expect(namesMatch('Sam Patel', 'Sam Patel')).toBe(true)
  expect(namesMatch('patel sam', 'Sam Patel')).toBe(true)
  expect(namesMatch("O'Neil, Sam", 'Sam ONeil')).toBe(true)
  expect(namesMatch('Lee', 'Lee')).toBe(true)
  expect(namesMatch('patel', 'Sam Patel')).toBe(false)
  expect(namesMatch('Sam', 'Sam Patel')).toBe(false)
  expect(namesMatch('Sam Patel Jones', 'Sam Patel')).toBe(false)
  expect(namesMatch('Alex Patel', 'Sam Patel')).toBe(false)
  expect(namesMatch('anything', '')).toBe(false)
  expect(namesMatch('', 'Sam Patel')).toBe(false)
})

const shiftDay = (date: string, days: number) => new Date(Date.parse(`${date}T12:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10)
/** The type and calendar the agent searched the new time with. */
const searched = () => ({ appointmentTypeId: typeId, calendarId: ws.assistantCalendar.id })

async function callFrom(tx: Tx, services: CalendarServices, from: string) {
  const started = await run(tx, agent_(null), services, 'call.start', { from, to: ws.number })
  return { callId: started.data!.callId as string, booking: started.data!.booking }
}

async function missesOf(tx: Tx, callId: string) {
  const [call] = await tx.select({ misses: calls.booking_misses }).from(calls).where(eq(calls.id, callId))
  return call!.misses
}

describe('appointment types', () => {
  test('add, change, and delete; one with bookings is switched off instead', async () => {
    const { services } = fakeCalendar()
    await inRollback(async tx => {
      const added = await run(tx, owner, services, 'appointmentType.upsert', { name: 'Estimate', durationMin: 30 })
      const id = (added.rows.appointment_types as { id: string }[])[0]!.id
      expect(added.rows.appointment_types).toMatchObject([{ name: 'Estimate', duration_min: 30, workspace_id: ws.id, enabled: true }])
      // New types ask for the name unless told otherwise; "name" is kept as its own column.
      expect(added.rows.appointment_types).toMatchObject([{ name_required: true, required_fields: [], instruction: '' }])
      const changed = await run(tx, owner, services, 'appointmentType.upsert', {
        appointmentTypeId: id, name: 'Estimate', durationMin: 30, requiredFields: ['phone', 'name', 'phone'], instruction: '  the caller wants a price first ',
      })
      expect(changed.rows.appointment_types).toMatchObject([{ name_required: true, required_fields: ['phone'], instruction: 'the caller wants a price first' }])
      const without = await run(tx, owner, services, 'appointmentType.upsert', { appointmentTypeId: id, name: 'Estimate', durationMin: 30, requiredFields: [] })
      expect(without.rows.appointment_types).toMatchObject([{ name_required: false, required_fields: [], instruction: 'the caller wants a price first' }])
      expect(() => actions.get('appointmentType.upsert')!.input.parse({ name: 'x', durationMin: 30, instruction: 'x'.repeat(301) })).toThrow()
      expect((await run(tx, owner, services, 'appointmentType.upsert', { appointmentTypeId: id, name: 'Free estimate', durationMin: 45 })).rows.appointment_types).toMatchObject([{ name: 'Free estimate', duration_min: 45 }])
      expect(await run(tx, owner, services, 'appointmentType.delete', { appointmentTypeId: id })).toMatchObject({ data: { deleted: true }, deleted: { appointment_types: [id] } })
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
      // The name is listed with the details, first; the condition comes along (empty: none).
      appointmentTypes: [
        { id: typeId, name: 'Repair visit', duration_min: 60, required_fields: ['name'], instruction: '' },
      ],
      calendars: [{ id: ws.assistantCalendar.id, name: 'Office', is_default: true }],
    })
    // No appointment type: nothing to book, the assistant takes messages.
    expect((await act(agent(), 'call.start', { from: '+15035550177', to: other.number })).body.data.booking).toBeNull()
  })

  test('members and the agent (for its call) may book; types are for owners and admins', async () => {
    for (const name of ['appointment.book', 'appointment.cancel']) {
      expect(actions.get(name)!.permission).toBe('calendar:write')
      for (const role of ['owner', 'admin', 'member'] as const) expect(rolePermissions[role]).toContain('calendar:write')
      expect(actions.get(name)!.agent).toBe('call')
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
