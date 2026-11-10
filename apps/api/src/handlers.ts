// Server side of the registry. Patch actions run generically; the rest have a handler here.
import { actions, recordingKey, type ActionDef, type ActionResult, type FindSlotsData } from '@callfront/actions'
import { findSlots, type FindSlotsInput, type Interval } from '@callfront/calendar'
import {
  appointment_types, assistants, availability_exceptions, availability_rules, bookings, calls, contacts, organization, phone_numbers, syncedTables,
  transcript_segments, workspace_settings, type Tx,
} from '@callfront/db'
import { TelephonyError, type TelephonyProvider } from '@callfront/telephony'
import { and, desc, eq, gt, gte, isNull, lt, lte, ne, sql } from 'drizzle-orm'
import { adminHandlers } from './admin-handlers.ts'
import type { Actor } from './context.ts'
import { type Handler, type HandlerCtx, Reject, type Undo } from './handler-context.ts'
import { telephonyProvider } from './provider-settings.ts'
import { recordingStoreFromEnv, type RecordingStore } from './recording-store.ts'

export { Reject, type HandlerCtx, type Undo }

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

/** Only `call.start` may run without a workspace: it is the action that resolves it. */
async function loadCall(tx: Tx, actor: Actor, callId: string) {
  if (!actor.workspaceId) throw new Reject('no workspace (send x-workspace-id)')
  const [call] = await tx.select().from(calls).where(and(eq(calls.id, callId), eq(calls.workspace_id, actor.workspaceId)))
  if (!call) throw new Reject('call not found')
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

/** A call that is still live after this long lost its agent; nobody will finish it. */
const STALE_LIVE_CALL_MS = 2 * 60 * 60 * 1000

function completeStaleCalls(tx: Tx, workspace_id: string, now: string) {
  const cutoff = new Date(Date.parse(now) - STALE_LIVE_CALL_MS).toISOString()
  return tx.update(calls).set({
    status: 'completed', ended_at: now,
    outcome: sql`coalesce(${calls.outcome}, 'answered')`, title: sql`coalesce(${calls.title}, 'Call ended without a summary')`,
  }).where(and(eq(calls.workspace_id, workspace_id), eq(calls.status, 'live'), lt(calls.started_at, cutoff))).returning()
}

/** How far back, and how many calls, the reconciliation below looks at per `call.start`. */
const ORPHAN_RECORDING_WINDOW_MS = 2 * 60 * 60 * 1000
const ORPHAN_RECORDING_LIMIT = 5

/**
 * Links recordings whose file exists but was never reported: the agent died or ran out of time
 * after hang-up. The key is derived, so this is a lookup per recently finished call.
 * Never fails the call that triggered it.
 */
async function linkOrphanRecordings(tx: Tx, workspace_id: string, now: string, recordings?: RecordingStore) {
  const since = new Date(Date.parse(now) - ORPHAN_RECORDING_WINDOW_MS).toISOString()
  const unlinked = await tx.select({ id: calls.id }).from(calls).where(and(
    eq(calls.workspace_id, workspace_id), eq(calls.status, 'completed'), isNull(calls.recording_key), gt(calls.ended_at, since),
  )).orderBy(desc(calls.ended_at)).limit(ORPHAN_RECORDING_LIMIT)
  if (!unlinked.length) return []
  try {
    const store = recordings ?? recordingStoreFromEnv(process.env)
    const found = await Promise.all(unlinked.map(async ({ id }) => ((await store.exists(recordingKey(workspace_id, id))) ? id : null)))
    const linked = await Promise.all(found.filter(id => id !== null).map(id =>
      tx.update(calls).set({ recording_key: recordingKey(workspace_id, id) }).where(eq(calls.id, id)).returning()))
    return linked.flat()
  } catch (e) {
    console.warn(`could not look for unlinked recordings: ${e instanceof Error ? e.message : e}`)
    return []
  }
}

const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** A carrier that is selected but not configured is the operator's to fix: say what is missing. */
async function configuredProvider(tx: Tx): Promise<TelephonyProvider> {
  try {
    return await telephonyProvider(tx)
  } catch (e) {
    throw new Reject(`phone setup is not configured: ${errorMessage(e)}`)
  }
}

/** Carrier failures are final for the command: the user sees the reason, the client does not retry. */
async function atCarrier<T>(request: () => Promise<T>): Promise<T> {
  try {
    return await request()
  } catch (e) {
    throw e instanceof TelephonyError ? new Reject(e.message) : e
  }
}

/** Gives a number that this command bought back to the carrier, so nothing is paid for without a row. */
const releaseBought = (provider: TelephonyProvider, number: { e164: string; providerRef: string }): Undo => async () => {
  try {
    await provider.releaseNumber(number)
    return `${number.e164} was released`
  } catch (e) {
    return `releasing ${number.e164} failed (${errorMessage(e)}): release it at the carrier, or set it up again`
  }
}

const handlers: Record<string, Handler> = {
  ...adminHandlers,

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

  'call.start': async ({ tx, now, recordings }, input) => {
    const [number] = await tx.select().from(phone_numbers).where(eq(phone_numbers.e164, input.to))
    if (!number) throw new Reject(`no workspace for number ${input.to}`)
    const workspace_id = number.workspace_id
    const [workspace] = await tx.select({ disabledAt: organization.disabledAt }).from(organization).where(eq(organization.id, workspace_id))
    if (workspace?.disabledAt) throw new Reject(`the workspace of ${input.to} is disabled`)
    let [contact] = await tx.select().from(contacts).where(and(eq(contacts.workspace_id, workspace_id), eq(contacts.phone, input.from)))
    const isNewContact = !contact
    if (!contact) [contact] = await tx.insert(contacts).values({ id: newId('ct'), workspace_id, phone: input.from }).returning()
    const id = newId('call')
    const [call] = await tx.insert(calls).values({
      id, workspace_id, contact_id: contact!.id, from_number: input.from, to_number: input.to,
      started_at: now, room: input.room ?? id,
    }).returning()
    const [assistant] = await tx.select().from(assistants).where(eq(assistants.workspace_id, workspace_id))
    const stale = await completeStaleCalls(tx, workspace_id, now)
    const linked = await linkOrphanRecordings(tx, workspace_id, now, recordings)
    return { rows: { calls: [call!, ...stale, ...linked], contacts: [contact!] }, data: { callId: id, workspaceId: workspace_id, isNewContact, contact: contact!, assistant: assistant ?? null } }
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

  'call.setRecording': async ({ tx, actor }, input) => {
    const call = await loadCall(tx, actor, input.callId)
    const recording_key = recordingKey(call.workspace_id, call.id, input.format)
    return { rows: { calls: await tx.update(calls).set({ recording_key }).where(eq(calls.id, call.id)).returning() } }
  },

  'call.takeMessage': async ({ tx, actor }, input) => {
    const call = await loadCall(tx, actor, input.callId)
    const action_items = [...call.action_items, { text: input.message }]
    return { rows: { calls: await tx.update(calls).set({ action_items }).where(eq(calls.id, call.id)).returning() } }
  },

  'phoneNumber.setup': async ({ tx, actor, now, telephony, onRollback }, input) => {
    if (!actor.workspaceId) throw new Reject('no workspace')
    const workspace_id = actor.workspaceId
    const provider = telephony ?? (await configuredProvider(tx))
    const sipEndpoint = process.env.LIVEKIT_SIP_ENDPOINT ?? ''
    if (provider.name !== 'dev' && !sipEndpoint) throw new Reject('phone setup is not configured: LIVEKIT_SIP_ENDPOINT is not set')

    // Only a purchase may search: attaching always names the number.
    const e164: string | undefined = input.e164 ?? (await atCarrier(() => provider.searchNumbers({ country: 'US', areaCode: input.areaCode, limit: 1 })))[0]?.e164
    if (!e164) throw new Reject(`no number available in area code ${input.areaCode}`)
    const [taken] = await tx.select().from(phone_numbers).where(eq(phone_numbers.e164, e164))
    if (taken) throw new Reject(`${e164} is already set up`)

    const existing = await atCarrier(() => provider.findNumber(e164))
    if (!existing && !input.purchase) {
      throw new Reject(`${e164} is not in the ${provider.name} account. Check the number; to buy it, pass purchase: true`)
    }
    const number = existing ?? (await atCarrier(() => provider.buyNumber(e164)))
    if (!existing) onRollback?.(releaseBought(provider, number))

    await atCarrier(() => provider.routeToSip(number, sipEndpoint))
    const rows = await tx.insert(phone_numbers).values({
      id: newId('pn'), workspace_id, e164, provider: provider.name, provider_ref: number.providerRef,
      // A bought number is the business's new number; an attached one is taken as a forwarding
      // target, the product's default, and counts as verified only after a test call.
      mode: input.mode ?? (existing ? 'forward_conditional' : 'new'),
      verified_at: existing ? null : now,
    }).returning()
    return { rows: { phone_numbers: rows } }
  },
}

for (const def of actions.values()) {
  if (!def.patch && !handlers[def.name]) throw new Error(`action ${def.name} has neither a patch nor a handler`)
}

export function runHandler(ctx: HandlerCtx, def: ActionDef, input: unknown) {
  return def.patch ? runPatch(ctx, def, input) : handlers[def.name]!(ctx, input)
}
