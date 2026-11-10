// Server side of the registry. Patch actions run generically; the rest have a handler here.
import { actions, type ActionDef, type ActionResult, type FindSlotsData } from '@callfront/actions'
import { findSlots, type FindSlotsInput, type Interval } from '@callfront/calendar'
import {
  appointment_types, assistants, availability_exceptions, availability_rules, bookings, calls, contacts, phone_numbers, syncedTables,
  transcript_segments, workspace_settings, type Tx,
} from '@callfront/db'
import { and, eq, gt, gte, lt, lte, ne } from 'drizzle-orm'
import type { Actor } from './context.ts'

/** A business-rule rejection: the command is final, clients must not retry it. */
export class Reject extends Error {}

type HandlerCtx = { tx: Tx; actor: Actor; now: string }
type Handler = (ctx: HandlerCtx, input: any) => Promise<Omit<ActionResult, 'ok'>>

const newId = (prefix: string) => `${prefix}_${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`

async function runPatch({ tx, actor, now }: HandlerCtx, def: ActionDef, input: unknown): Promise<Omit<ActionResult, 'ok'>> {
  const patch = def.patch!
  if (!actor.workspaceId) throw new Reject('no workspace')
  const table = syncedTables[patch.table]
  const scope = and(eq(table.id, patch.id(input)), eq(table.workspace_id, actor.workspaceId))
  const values = patch.set(input, now)
  const rows = Object.keys(values).length
    ? await tx.update(table).set(values).where(scope).returning()
    : await tx.select().from(table).where(scope)
  if (!rows[0]) throw new Reject(`${patch.table} row not found`)
  return { rows: { [patch.table]: rows } }
}

async function loadCall(tx: Tx, actor: Actor, callId: string) {
  const [call] = await tx.select().from(calls).where(eq(calls.id, callId))
  if (!call || (actor.workspaceId && call.workspace_id !== actor.workspaceId)) throw new Reject('call not found')
  return call
}

const DAY_MS = 86_400_000
/** Used until a workspace has stored its own time zone. */
const DEFAULT_TIME_ZONE = 'America/New_York'
const shift = (iso: string, ms: number) => new Date(Date.parse(iso) + ms).toISOString()
const earlier = (a: string, b: string) => (Date.parse(a) <= Date.parse(b) ? a : b)

/** Bookings that can collide with a slot in `window`, the buffer on both sides included. */
function loadBusy(tx: Tx, workspaceId: string, window: Interval, bufferMin: number) {
  const bufferMs = bufferMin * 60_000
  return tx.select({ start: bookings.start_at, end: bookings.end_at }).from(bookings).where(and(
    eq(bookings.workspace_id, workspaceId), ne(bookings.status, 'cancelled'),
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

const handlers: Record<string, Handler> = {
  'calendar.findSlots': async ({ tx, actor, now }, input) => {
    const workspaceId = actor.workspaceId
    if (!workspaceId) throw new Reject('no workspace')
    const [type] = await tx.select().from(appointment_types).where(and(eq(appointment_types.id, input.appointmentTypeId), eq(appointment_types.workspace_id, workspaceId)))
    if (!type?.enabled) throw new Reject('appointment type not found')
    const [settings] = await tx.select().from(workspace_settings).where(eq(workspace_settings.workspace_id, workspaceId))
    const timeZone = settings?.timezone ?? DEFAULT_TIME_ZONE

    // Nothing is bookable after the horizon, so nothing is loaded for it either.
    const horizon = shift(now, (type.max_days_ahead + 1) * DAY_MS)
    const window = { start: input.from ?? now, end: earlier(input.to ?? horizon, horizon) }
    const slots = findSlotsOrReject({
      timeZone,
      hours: await tx.select().from(availability_rules).where(eq(availability_rules.workspace_id, workspaceId)),
      exceptions: await loadExceptions(tx, workspaceId, window),
      appointmentType: type,
      busy: await loadBusy(tx, workspaceId, window, type.buffer_min),
      window,
      now,
      limit: input.limit,
    })
    return { rows: {}, data: { appointmentTypeId: type.id, timeZone, slots } satisfies FindSlotsData }
  },

  'call.start': async ({ tx, now }, input) => {
    const [number] = await tx.select().from(phone_numbers).where(eq(phone_numbers.e164, input.to))
    if (!number) throw new Reject(`no workspace for number ${input.to}`)
    const workspace_id = number.workspace_id
    let [contact] = await tx.select().from(contacts).where(and(eq(contacts.workspace_id, workspace_id), eq(contacts.phone, input.from)))
    const isNewContact = !contact
    if (!contact) [contact] = await tx.insert(contacts).values({ id: newId('ct'), workspace_id, phone: input.from }).returning()
    const id = newId('call')
    const [call] = await tx.insert(calls).values({
      id, workspace_id, contact_id: contact!.id, from_number: input.from, to_number: input.to,
      started_at: now, room: input.room ?? id,
    }).returning()
    const [assistant] = await tx.select().from(assistants).where(eq(assistants.workspace_id, workspace_id))
    return { rows: { calls: [call!], contacts: [contact!] }, data: { callId: id, workspaceId: workspace_id, isNewContact, contact: contact!, assistant: assistant ?? null } }
  },

  'call.appendTranscript': async ({ tx, actor }, input) => {
    const call = await loadCall(tx, actor, input.callId)
    const [segment] = await tx.insert(transcript_segments).values({
      id: newId('seg'), workspace_id: call.workspace_id, call_id: call.id,
      speaker: input.speaker, text: input.text, at_ms: input.atMs, tool_event: input.toolEvent ?? null,
    }).returning()
    return { rows: { transcript_segments: [segment!] } }
  },

  'call.finish': async ({ tx, actor, now }, input) => {
    const call = await loadCall(tx, actor, input.callId)
    const duration_sec = Math.max(0, Math.round((Date.parse(now) - Date.parse(call.started_at)) / 1000))
    const [updated] = await tx.update(calls).set({
      status: 'completed', ended_at: now, duration_sec,
      outcome: input.outcome ?? 'answered', urgency: input.urgency ?? call.urgency,
      title: input.title ?? call.title, summary: input.summary ?? call.summary,
      action_items: input.actionItems ?? call.action_items, fields: input.fields ?? call.fields,
    }).where(eq(calls.id, call.id)).returning()
    const rows: ActionResult['rows'] = { calls: [updated!] }
    if (input.callerName && call.contact_id) {
      const [contact] = await tx.select().from(contacts).where(eq(contacts.id, call.contact_id))
      if (contact && !contact.name) rows.contacts = await tx.update(contacts).set({ name: input.callerName }).where(eq(contacts.id, contact.id)).returning()
    }
    return { rows }
  },
}

for (const def of actions.values()) {
  if (!def.patch && !handlers[def.name]) throw new Error(`action ${def.name} has neither a patch nor a handler`)
}

export function runHandler(ctx: HandlerCtx, def: ActionDef, input: unknown) {
  return def.patch ? runPatch(ctx, def, input) : handlers[def.name]!(ctx, input)
}
