// Server side of the registry. Patch actions run generically; the rest have a handler here.
import { actions, confirmsNumber, recordingKey, testCallContact, type ActionDef, type ActionResult, type CallTestFinding, type FindSlotsData } from '@linedesk/actions'
import { businessHoursContext, type BusinessHoursContext, findSlots, type FindSlotsInput, type Interval } from '@linedesk/calendar'
import {
  appointment_types, assistants, availability_exceptions, availability_rules, bookings, calls, contacts, organization, phone_numbers, syncedTables,
  transcript_segments, workspace_settings, type Tx,
} from '@linedesk/db'
import { TelephonyError, type TelephonyProvider } from '@linedesk/telephony'
import { and, asc, desc, eq, gt, gte, lt, lte, ne } from 'drizzle-orm'
import { adminHandlers } from './admin-handlers.ts'
import { impersonationHandlers } from './impersonation.ts'
import type { Actor } from './context.ts'
import { type Handler, type HandlerCtx, Reject, type Undo } from './handler-context.ts'
import { telephonyProvider } from './provider-settings.ts'
import { startTestCall } from './test-call.ts'
import { teamHandlers } from './team.ts'
import { workspaceSettingsHandlers } from './workspace-settings.ts'
import { queueCallNotification } from './jobs.ts'
import { notificationHandlers } from './notification-settings.ts'

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

const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** A carrier that is selected but not configured is the operator's to fix: say what is missing. */
/** Whether `phoneNumber.setup` can work on this server: the carrier it would use, or why it cannot. */
export type PhoneSetupStatus = { provider: string | null; problem: string | null }

export async function phoneSetupStatus(loadProvider: () => Promise<{ name: string }>, env: Record<string, string | undefined> = process.env): Promise<PhoneSetupStatus> {
  try {
    const { name } = await loadProvider()
    if (name !== 'dev' && !env.LIVEKIT_SIP_ENDPOINT) return { provider: name, problem: 'LIVEKIT_SIP_ENDPOINT is not set' }
    return { provider: name, problem: null }
  } catch (e) {
    return { provider: null, problem: errorMessage(e) }
  }
}

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

/**
 * The workspace's business hours for the voice agent: open now or not, when that changes, and a
 * sentence it can use ("Closed now; opens tomorrow at 7:00 AM"). null when no hours are set.
 */
async function businessHoursFor(tx: Tx, workspace_id: string, now: string): Promise<BusinessHoursContext | null> {
  const rules = await tx.select().from(availability_rules).where(eq(availability_rules.workspace_id, workspace_id))
  if (!rules.length) return null
  const [settings] = await tx.select({ timezone: workspace_settings.timezone }).from(workspace_settings).where(eq(workspace_settings.workspace_id, workspace_id))
  try {
    return businessHoursContext(rules, settings?.timezone ?? DEFAULT_TIME_ZONE, Date.parse(now))
  } catch (e) {
    console.warn(`business hours of ${workspace_id} could not be read: ${errorMessage(e)}`)
    return null
  }
}

type OpenCall = { from: string; to: string; room?: string; source?: 'phone' | 'test'; label: string }

/**
 * Registers a live call in a workspace: finds or creates the caller and opens the call. On the path to
 * the greeting, so it does nothing else: stale calls and unreported recordings are the API's minute
 * sweeps (stale-calls.ts, orphan-recordings.ts).
 */
async function openCall({ tx, now }: Pick<HandlerCtx, 'tx' | 'now'>, workspace_id: string, { from, to, room, source = 'phone', label }: OpenCall) {
  const [workspace] = await tx.select({ disabledAt: organization.disabledAt }).from(organization).where(eq(organization.id, workspace_id))
  // A phone number always has its workspace; a test call names it, so it has to exist.
  if (!workspace && source === 'test') throw new Reject('no such workspace')
  if (workspace?.disabledAt) throw new Reject(`the workspace of ${label} is disabled`)
  let [contact] = await tx.select().from(contacts).where(and(eq(contacts.workspace_id, workspace_id), eq(contacts.phone, from)))
  // A deleted contact who calls again is back in Contacts.
  if (contact?.deleted_at) [contact] = await tx.update(contacts).set({ deleted_at: null }).where(eq(contacts.id, contact.id)).returning()
  const isNewContact = !contact
  if (!contact) {
    const name = source === 'test' ? testCallContact.name : null
    ;[contact] = await tx.insert(contacts).values({ id: newId('ct'), workspace_id, phone: from, name }).returning()
  }
  const id = newId('call')
  // A blocked caller is not answered: the call is filed quietly in Spam and the agent hangs up (`blocked`).
  const blocked = source === 'phone' && !!contact!.blocked_at
  const [call] = await tx.insert(calls).values({
    id, workspace_id, contact_id: contact!.id, from_number: from, to_number: to, source, started_at: now, room: room ?? id,
    ...(blocked ? blockedCall(now) : {}),
  }).returning()
  const [assistant] = await tx.select().from(assistants).where(eq(assistants.workspace_id, workspace_id))
  const businessHours = await businessHoursFor(tx, workspace_id, now)
  return { rows: { calls: [call!], contacts: [contact!] }, data: { callId: id, workspaceId: workspace_id, isNewContact, contact: contact!, assistant: assistant ?? null, blocked, businessHours } }
}

/** A call from a blocked number: over before it began, read, in Spam. */
const blockedCall = (now: string) => ({
  status: 'completed' as const, ended_at: now, duration_sec: 0, outcome: 'spam' as const, unread: false,
  title: 'Blocked caller', summary: 'This number is blocked, so the call was not answered.',
})

const handlers: Record<string, Handler> = {
  ...adminHandlers,
  ...impersonationHandlers,
  ...teamHandlers,
  ...workspaceSettingsHandlers,
  ...notificationHandlers,

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

  'contact.create': async ({ tx, actor }, input) => {
    if (!actor.workspaceId) throw new Reject('no workspace')
    const [existing] = await tx.select().from(contacts).where(and(eq(contacts.workspace_id, actor.workspaceId), eq(contacts.phone, input.phone)))
    if (existing && !existing.deleted_at) throw new Reject(`${input.phone} is already a contact`)
    const fields = { name: input.name ?? null, company: input.company ?? null }
    const [contact] = existing
      ? await tx.update(contacts).set({ ...fields, deleted_at: null }).where(eq(contacts.id, existing.id)).returning()
      : await tx.insert(contacts).values({ id: newId('ct'), workspace_id: actor.workspaceId, phone: input.phone, ...fields }).returning()
    return { rows: { contacts: [contact!] }, data: { contactId: contact!.id } }
  },

  'call.start': async ({ tx, now }, input) => {
    const [number] = await tx.select().from(phone_numbers).where(eq(phone_numbers.e164, input.to))
    if (!number) throw new Reject(`no workspace for number ${input.to}`)
    return openCall({ tx, now }, number.workspace_id, { from: input.from, to: input.to, room: input.room, label: input.to })
  },

  // The agent only knows the workspace from the dispatch the API signed (assistant.startTestCall).
  'call.startTest': async ({ tx, actor, now }, input) => {
    if (!actor.workspaceId) throw new Reject('no workspace (send x-workspace-id)')
    return openCall({ tx, now }, actor.workspaceId, { from: testCallContact.phone, to: testCallContact.phone, room: input.room, source: 'test', label: 'this test call' })
  },

  'call.findForTest': async ({ tx }, input) => {
    const [number] = await tx.select().from(phone_numbers).where(eq(phone_numbers.e164, input.to))
    if (!number) throw new Reject(`${input.to} is not set up in any workspace`)
    // A phone call comes in on the number; a no-phone test call is found by its room.
    const which = input.room ? eq(calls.room, input.room) : input.from ? and(eq(calls.from_number, input.from), eq(calls.to_number, input.to)) : undefined
    const [call] = which
      ? await tx.select().from(calls).where(and(eq(calls.workspace_id, number.workspace_id), which, gte(calls.started_at, input.since))).orderBy(desc(calls.started_at)).limit(1)
      : []
    const segments = call
      ? await tx.select({ speaker: transcript_segments.speaker, text: transcript_segments.text, at_ms: transcript_segments.at_ms }).from(transcript_segments)
        .where(eq(transcript_segments.call_id, call.id)).orderBy(asc(transcript_segments.at_ms))
      : []
    const count = (speaker: string) => segments.filter(s => s.speaker === speaker).length
    const data: CallTestFinding = {
      workspaceId: number.workspace_id,
      call: call ? {
        id: call.id, status: call.status, outcome: call.outcome, urgency: call.urgency, title: call.title, summary: call.summary,
        recording_key: call.recording_key, duration_sec: call.duration_sec, action_items: call.action_items.length,
      } : null,
      turns: { caller: count('caller'), agent: count('agent'), system: count('system') },
      lines: segments,
    }
    return { rows: {}, data }
  },

  'assistant.startTestCall': async ({ actor }) => ({ rows: {}, data: startTestCall(actor) }),

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
    // Only the first finish notifies; a repeated one (agent retry after a timeout) is not news.
    if (call.status !== 'completed') await queueCallNotification(tx, call.id)
    return { rows }
  },

  'call.setRecording': async ({ tx, actor }, input) => {
    const call = await loadCall(tx, actor, input.callId)
    const recording_key = recordingKey(call.workspace_id, call.id, input.format)
    // An agent that does not say (older versions) recorded into the store RECORDING_STORE names: null.
    const recording_store = input.store ?? null
    return { rows: { calls: await tx.update(calls).set({ recording_key, recording_store }).where(eq(calls.id, call.id)).returning() } }
  },

  'call.takeMessage': async ({ tx, actor }, input) => {
    const call = await loadCall(tx, actor, input.callId)
    const action_items = [...call.action_items, { text: input.message }]
    return { rows: { calls: await tx.update(calls).set({ action_items }).where(eq(calls.id, call.id)).returning() } }
  },

  'onboarding.setStep': async ({ tx, actor }, input) => {
    if (!actor.workspaceId) throw new Reject('no workspace')
    await tx.insert(workspace_settings).values({ workspace_id: actor.workspaceId, timezone: DEFAULT_TIME_ZONE, onboarding_step: input.step })
      .onConflictDoUpdate({ target: workspace_settings.workspace_id, set: { onboarding_step: input.step } })
    return { rows: {} }
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
      purchased: !existing,
      verified_at: existing ? null : now,
    }).returning()
    return { rows: { phone_numbers: rows } }
  },

  // Detaches the number from the workspace; a number Linedesk bought also goes back to the carrier, an
  // attached one is taken off Linedesk's routing there (its other settings at the carrier stay).
  // The carrier is asked last, right before the commit: if it refuses, nothing changes here.
  'phoneNumber.release': async ({ tx, actor, telephony }, input) => {
    if (!actor.workspaceId) throw new Reject('no workspace')
    const [number] = await tx.select().from(phone_numbers)
      .where(and(eq(phone_numbers.id, input.phoneNumberId), eq(phone_numbers.workspace_id, actor.workspaceId)))
    if (!number) throw new Reject('phone number not found')
    if (!confirmsNumber(input.confirm, number.e164)) throw new Reject(`type the number ${number.e164} to confirm`)
    await tx.delete(phone_numbers).where(eq(phone_numbers.id, number.id))
    const owned = number.provider_ref ? { e164: number.e164, providerRef: number.provider_ref } : null
    let releasedAtCarrier = false
    let unroutedAtCarrier = false
    if (number.provider !== 'dev') {
      const provider = telephony ?? (await configuredProvider(tx))
      if (number.purchased) {
        // A bought number goes back to the carrier: only at the carrier that has it.
        if (provider.name !== number.provider) {
          throw new Reject(`${number.e164} is at ${number.provider}, but ${provider.name} is the carrier in use: release it there, or switch the carrier back first`)
        }
        if (!owned) throw new Reject(`${number.e164} has no carrier reference: release it at ${number.provider}`)
        await atCarrier(() => provider.releaseNumber(owned))
        releasedAtCarrier = true
      } else if (provider.name === number.provider && owned) {
        // An attached number stays the business's but stops reaching Linedesk. At another carrier than the
        // one in use, or without a reference, there is nothing Linedesk can reach: it is only detached here.
        await atCarrier(() => provider.unrouteNumber(owned))
        unroutedAtCarrier = true
      }
    }
    // No rows: the delete reaches browsers through read sync (a returned row would be written back locally).
    return { rows: {}, data: { releasedAtCarrier, unroutedAtCarrier } }
  },
}

for (const def of actions.values()) {
  if (!def.patch && !handlers[def.name]) throw new Error(`action ${def.name} has neither a patch nor a handler`)
}

export function runHandler(ctx: HandlerCtx, def: ActionDef, input: unknown) {
  return def.patch ? runPatch(ctx, def, input) : handlers[def.name]!(ctx, input)
}
