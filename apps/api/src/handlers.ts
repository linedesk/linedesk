// Server side of the registry. Patch actions run generically; the rest have a handler here.
import { actions, confirmsNumber, recordingKey, testCallContact, type ActionDef, type ActionResult, type CallTestFinding, } from '@linedesk/actions'
import { businessHoursContext, type BusinessHoursContext, } from '@linedesk/calendar'
import {availability_rules, call_evaluations, calls, contacts, member, organization, phone_numbers, syncedTables,
  transcript_segments, workspace_settings, type Tx,
} from '@linedesk/db'
import type { Assistant, PhoneNumber } from '@linedesk/db/types'
import { TelephonyError, type TelephonyProvider } from '@linedesk/telephony'
import { and, asc, desc, eq, gte, } from 'drizzle-orm'
import { adminHandlers } from './admin-handlers.ts'
import { apiKeyHandlers } from './api-keys.ts'
import { assistantForNumber, assistantHandlers, assistantIn } from './assistants.ts'
import { bookingContext, bookingHandlers, bookingsForTest, DEFAULT_TIME_ZONE } from './bookings.ts'
import { calendarConnectionHandlers } from './calendar-connections.ts'
import { type CarrierAccount, carrierHandlers, INSTALL_NUMBER_ADMIN_ONLY, lockWorkspaceCarrier, ownCarrierProvider, telephonyForWorkspace } from './workspace-carrier.ts'
import { refreshTransferTrunk, transferTrunkHandlers } from './transfer-trunk.ts'
import { impersonationHandlers } from './impersonation.ts'
import type { Actor } from './context.ts'
import { type Handler, type HandlerCtx, type Preparer, Reject, type Undo } from './handler-context.ts'
import { telephonyProvider } from './provider-settings.ts'
import { startTestCall } from './test-call.ts'
import { membershipHandlers } from './memberships.ts'
import { teamHandlers } from './team.ts'
import { transferHandlers } from './transfers.ts'
import { recordingNoticeFor, workspaceSettingsHandlers } from './workspace-settings.ts'
import { checkAssistantVoice, releaseUnusedClones, voiceHandlers, voicePreparers } from './voices.ts'
import { sampleHandlers } from './sample-calls.ts'
import { queueCallEvaluation, queueCallNotification, queueCallPush } from './jobs.ts'
import { evaluatedAutomatically, evaluationHandlers } from './evaluations.ts'
import { notificationHandlers } from './notification-settings.ts'
import { pushHandlers } from './push.ts'
import { contactImportHandlers } from './contact-import.ts'
import { contactMergeHandlers } from './contact-merge.ts'
import { clearCallPayloads, queueCallFinishedEvents, queueWebhookEvent, webhookData, webhookHandlers } from './webhooks.ts'

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

/** The carrier a workspace sets numbers up with (its own account, else the install's). `telephony` overrides it in tests. */
async function setupCarrier(tx: Tx, workspaceId: string, telephony?: TelephonyProvider): Promise<{ provider: TelephonyProvider; account: CarrierAccount }> {
  try {
    const resolved = await telephonyForWorkspace(tx, workspaceId)
    return telephony ? { provider: telephony, account: resolved.account } : resolved
  } catch (e) {
    if (e instanceof Reject) throw e
    throw new Reject(`phone setup is not configured: ${errorMessage(e)}`)
  }
}

/**
 * The carrier account a number is in: the workspace's own (only ever the number's own workspace) or the
 * install's. A number in the workspace's account is never handed to the install's carrier, or the reverse.
 */
async function releaseCarrier(tx: Tx, number: PhoneNumber): Promise<TelephonyProvider> {
  if (number.carrier_account === 'install') return configuredProvider(tx)
  const own = await ownCarrierProvider(tx, number.workspace_id)
  if (!own) throw new Reject(`${number.e164} is in the workspace's own carrier account, which is not set up any more: release it there`)
  return own
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
  // Hours are opt-in: until the workspace turns them on the assistant says nothing about them.
  const [settings] = await tx.select({ timezone: workspace_settings.timezone, on: workspace_settings.business_hours_on }).from(workspace_settings).where(eq(workspace_settings.workspace_id, workspace_id))
  if (!settings?.on) return null
  const rules = await tx.select().from(availability_rules).where(eq(availability_rules.workspace_id, workspace_id))
  if (!rules.length) return null
  try {
    return businessHoursContext(rules, settings?.timezone ?? DEFAULT_TIME_ZONE, Date.parse(now))
  } catch (e) {
    console.warn(`business hours of ${workspace_id} could not be read: ${errorMessage(e)}`)
    return null
  }
}

type OpenCall = { from: string; to: string; room?: string; source?: 'phone' | 'test'; label: string; assistant: Assistant | null }

/**
 * Registers a live call in a workspace: finds or creates the caller and opens the call. On the path to
 * the greeting, so it does nothing else: stale calls and unreported recordings are the API's minute
 * sweeps (stale-calls.ts, orphan-recordings.ts).
 */
async function openCall({ tx, now }: Pick<HandlerCtx, 'tx' | 'now'>, workspace_id: string, { from, to, room, source = 'phone', label, assistant }: OpenCall) {
  const [workspace] = await tx.select({ disabledAt: organization.disabledAt }).from(organization).where(eq(organization.id, workspace_id))
  // A phone number always has its workspace; a test call names it, so it has to exist.
  if (!workspace && source === 'test') throw new Reject('no such workspace')
  if (workspace?.disabledAt) throw new Reject(`the workspace of ${label} is disabled`)
  let [contact] = await tx.select().from(contacts).where(and(eq(contacts.workspace_id, workspace_id), eq(contacts.phone, from)))
  // A number of a contact that was merged into another one belongs to that one now.
  if (contact?.merged_into) [contact] = await tx.select().from(contacts).where(and(eq(contacts.workspace_id, workspace_id), eq(contacts.id, contact.merged_into)))
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
    assistant_id: assistant?.id ?? null,
    ...(blocked ? blockedCall(now) : {}),
  }).returning()
  const businessHours = await businessHoursFor(tx, workspace_id, now)
  const booking = blocked ? null : await bookingContext(tx, workspace_id, now, { contactId: contact!.id, assistantId: assistant?.id ?? null })
  // Said right after the greeting; the agent appends it (null: off).
  const recordingNotice = blocked ? null : await recordingNoticeFor(tx, workspace_id)
  return { rows: { calls: [call!], contacts: [contact!] }, data: { callId: id, workspaceId: workspace_id, isNewContact, contact: contact!, assistant: assistant ?? null, blocked, businessHours, booking, recordingNotice } }
}

/** A call from a blocked number: over before it began, read, in Spam. */
const blockedCall = (now: string) => ({
  status: 'completed' as const, ended_at: now, duration_sec: 0, outcome: 'spam' as const, unread: false,
  title: 'Blocked caller', summary: 'This number is blocked, so the call was not answered.',
})

/**
 * The on-call number is a person's phone, never a Linedesk number (the workspace's own or any other on the
 * install): a transfer there would ring back into Linedesk and be answered by an assistant.
 */
async function checkOnCallNotLinedesk(tx: HandlerCtx['tx'], e164: string) {
  const [linedesk] = await tx.select({ id: phone_numbers.id }).from(phone_numbers).where(eq(phone_numbers.e164, e164)).limit(1)
  if (linedesk) throw new Reject("the on-call number is a Linedesk number; enter the on-call person's own phone")
}

/** Actions with work before their transaction (handler-context.ts, Preparer). */
export const preparers: Record<string, Preparer> = { ...voicePreparers }

const handlers: Record<string, Handler> = {
  // The patch, plus: a voice must be one the workspace may use, and a clone it stops using is released.
  'assistant.update': async (ctx, input) => {
    if (!ctx.actor.workspaceId) throw new Reject('no workspace')
    if (input.voice) await checkAssistantVoice(ctx.tx, ctx.actor.workspaceId, input.voice)
    if (input.transfer_number) await checkOnCallNotLinedesk(ctx.tx, input.transfer_number)
    const result = await runPatch(ctx, actions.get('assistant.update')!, input)
    if (input.voice) await releaseUnusedClones(ctx.tx, ctx.actor.workspaceId)
    return result
  },

  ...adminHandlers,
  ...assistantHandlers,
  ...impersonationHandlers,
  ...teamHandlers,
  ...membershipHandlers,
  ...workspaceSettingsHandlers,
  ...transferHandlers,
  ...voiceHandlers,
  ...sampleHandlers,
  ...notificationHandlers,
  ...pushHandlers,
  ...calendarConnectionHandlers,
  ...carrierHandlers(),
  ...transferTrunkHandlers(),
  ...apiKeyHandlers,
  ...bookingHandlers,
  ...evaluationHandlers(queueCallEvaluation),
  ...webhookHandlers,

  // The patch, and the webhook payloads that carry the call are cleared (they hold the caller's details).
  'call.delete': async (ctx, input) => {
    const result = await runPatch(ctx, actions.get('call.delete')!, input)
    await clearCallPayloads(ctx.tx, ctx.actor.workspaceId!, input.callId)
    // Its evaluation goes too (it quotes what went wrong on the call); a restored call can be evaluated again.
    await ctx.tx.delete(call_evaluations).where(and(eq(call_evaluations.call_id, input.callId), eq(call_evaluations.workspace_id, ctx.actor.workspaceId!)))
    return result
  },

  'contact.create': async ({ tx, actor }, input) => {
    if (!actor.workspaceId) throw new Reject('no workspace')
    const [existing] = await tx.select().from(contacts).where(and(eq(contacts.workspace_id, actor.workspaceId), eq(contacts.phone, input.phone)))
    if (existing && (!existing.deleted_at || existing.merged_into)) throw new Reject(`${input.phone} is already a contact`)
    const fields = { name: input.name ?? null, company: input.company ?? null }
    const [contact] = existing
      ? await tx.update(contacts).set({ ...fields, deleted_at: null }).where(eq(contacts.id, existing.id)).returning()
      : await tx.insert(contacts).values({ id: newId('ct'), workspace_id: actor.workspaceId, phone: input.phone, ...fields }).returning()
    return { rows: { contacts: [contact!] }, data: { contactId: contact!.id } }
  },

  ...contactImportHandlers,
  ...contactMergeHandlers,

  'call.start': async ({ tx, now }, input) => {
    const [number] = await tx.select().from(phone_numbers).where(eq(phone_numbers.e164, input.to))
    if (!number) throw new Reject(`no workspace for number ${input.to}`)
    const assistant = await assistantForNumber(tx, number.workspace_id, number.assistant_id)
    return openCall({ tx, now }, number.workspace_id, { from: input.from, to: input.to, room: input.room, label: input.to, assistant })
  },

  // The agent only knows the workspace from the dispatch the API signed (assistant.startTestCall).
  'call.startTest': async ({ tx, actor, now }, input) => {
    if (!actor.workspaceId) throw new Reject('no workspace (send x-workspace-id)')
    // The assistant comes from the signed dispatch; it must still be one of this workspace's.
    const [workspace] = await tx.select({ id: organization.id }).from(organization).where(eq(organization.id, actor.workspaceId))
    if (!workspace) throw new Reject('no such workspace')
    const assistant = await assistantIn(tx, actor.workspaceId, input.assistantId)
    return openCall({ tx, now }, actor.workspaceId, { from: testCallContact.phone, to: testCallContact.phone, room: input.room, source: 'test', label: 'this test call', assistant })
  },

  'call.findForTest': async ({ tx, now, calendars }, input) => {
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
        transfer_result: call.transfer_result,
      } : null,
      turns: { caller: count('caller'), agent: count('agent'), system: count('system') },
      lines: segments,
      bookingReady: (await bookingContext(tx, number.workspace_id, now, { assistantId: number.assistant_id })) !== null,
      bookings: call ? await bookingsForTest(tx, { calendars }, number.workspace_id, call.id) : [],
    }
    return { rows: {}, data }
  },

  'assistant.startTestCall': async ({ tx, actor }, input) => {
    if (!actor.workspaceId) throw new Reject('no workspace')
    // Only an assistant of the caller's own workspace goes into the signed dispatch.
    const assistant = input.assistantId ? await assistantIn(tx, actor.workspaceId, input.assistantId) : null
    return { rows: {}, data: startTestCall(actor, assistant?.id) }
  },

  // Only a member of the call's workspace can be its assignee (a user of another workspace is refused).
  'call.assign': async ({ tx, actor }, input) => {
    if (!actor.workspaceId) throw new Reject('no workspace')
    // Same answer as the patch it stands in for: a call of another workspace is not found.
    const [call] = await tx.select().from(calls).where(and(eq(calls.id, input.callId), eq(calls.workspace_id, actor.workspaceId)))
    if (!call) throw new Reject('calls row not found')
    if (input.userId) {
      const [isMember] = await tx.select({ id: member.id }).from(member)
        .where(and(eq(member.organizationId, call.workspace_id), eq(member.userId, input.userId)))
      if (!isMember) throw new Reject('that user is not a member of this workspace')
    }
    return { rows: { calls: await tx.update(calls).set({ assignee_id: input.userId }).where(eq(calls.id, call.id)).returning() } }
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
    // Only the first finish notifies; a repeated one (agent retry after a timeout) is not news.
    if (call.status !== 'completed') {
      await queueCallNotification(tx, call.id)
      await queueCallPush(tx, call.id, 'finished')
      // Test calls are evaluated only when the call view asks (call.evaluate).
      if (evaluatedAutomatically(updated!)) await queueCallEvaluation(tx, call.id)
      await queueCallFinishedEvents(tx, updated!, now)
    }
    return { rows }
  },

  'call.setRecording': async ({ tx, actor }, input) => {
    const call = await loadCall(tx, actor, input.callId)
    const recording_key = recordingKey(call.workspace_id, call.id, input.format)
    // An agent that does not say (older versions) recorded into the store RECORDING_STORE names: null.
    const recording_store = input.store ?? null
    return { rows: { calls: await tx.update(calls).set({ recording_key, recording_store }).where(eq(calls.id, call.id)).returning() } }
  },

  'call.takeMessage': async ({ tx, actor, now }, input) => {
    const call = await loadCall(tx, actor, input.callId)
    const action_items = [...call.action_items, { text: input.message }]
    if (call.source !== 'test') {
      await queueWebhookEvent(tx, call.workspace_id, 'message.taken', webhookData.messageTaken(call, input.message), now)
      await queueCallPush(tx, call.id, 'message')
    }
    return { rows: { calls: await tx.update(calls).set({ action_items }).where(eq(calls.id, call.id)).returning() } }
  },

  // The same update as the action's patch, plus a push the first time a call becomes urgent.
  'call.flagUrgent': async ({ tx, actor }, input: { callId: string }) => {
    const call = await loadCall(tx, actor, input.callId)
    const rows = await tx.update(calls).set({ urgency: 'urgent' }).where(eq(calls.id, call.id)).returning()
    if (call.urgency !== 'urgent' && call.source !== 'test') await queueCallPush(tx, call.id, 'urgent')
    return { rows: { calls: rows } }
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
    // Serialised with carrier.set, so the carrier cannot change while a number is set up with it.
    await lockWorkspaceCarrier(tx, workspace_id)
    const { provider, account: carrier_account } = await setupCarrier(tx, workspace_id, telephony)
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
    // The install's account is shared by every workspace: only an instance admin may hand one of its
    // numbers to a workspace. Others buy a new one, or bring their own account. (`dev` has no account.)
    if (existing && carrier_account === 'install' && provider.name !== 'dev' && !actor.permissions.includes('instance:admin')) {
      throw new Reject(INSTALL_NUMBER_ADMIN_ONLY)
    }
    const number = existing ?? (await atCarrier(() => provider.buyNumber(e164)))
    if (!existing) onRollback?.(releaseBought(provider, number))

    // Checked before the carrier is asked to route anything.
    const assistant = await assistantIn(tx, workspace_id, input.assistantId)
    await atCarrier(() => provider.routeToSip(number, sipEndpoint))
    const rows = await tx.insert(phone_numbers).values({
      id: newId('pn'), workspace_id, e164, provider: provider.name, provider_ref: number.providerRef, carrier_account,
      assistant_id: assistant?.id ?? null,
      // A bought number is the business's new number; an attached one is taken as a forwarding
      // target, the product's default, and counts as verified only after a test call.
      mode: input.mode ?? (existing ? 'forward_conditional' : 'new'),
      purchased: !existing,
      verified_at: existing ? null : now,
    }).returning()
    // Warm transfers from a number in the workspace account dial through that account: set its trunk up now.
    if (carrier_account === 'workspace') await refreshTransferTrunk(tx, workspace_id, { actorId: actor.actorId, trigger: 'phoneNumber.setup', impersonatedBy: actor.impersonation?.by })
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
    await lockWorkspaceCarrier(tx, actor.workspaceId)
    await tx.delete(phone_numbers).where(eq(phone_numbers.id, number.id))
    const owned = number.provider_ref ? { e164: number.e164, providerRef: number.provider_ref } : null
    let releasedAtCarrier = false
    let unroutedAtCarrier = false
    if (number.provider !== 'dev') {
      const provider = telephony ?? (await releaseCarrier(tx, number))
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
    // The trunk keeps only the remaining numbers as caller IDs (or goes, without any).
    if (number.carrier_account === 'workspace') await refreshTransferTrunk(tx, actor.workspaceId, { actorId: actor.actorId, trigger: 'phoneNumber.release', impersonatedBy: actor.impersonation?.by })
    return { rows: {}, deleted: { phone_numbers: [number.id] }, data: { releasedAtCarrier, unroutedAtCarrier } }
  },
}

for (const def of actions.values()) {
  if (!def.patch && !handlers[def.name]) throw new Error(`action ${def.name} has neither a patch nor a handler`)
}

/** The actions with a server handler (tests check which also have a patch). */
export const handlerNames: ReadonlySet<string> = new Set(Object.keys(handlers))

/** A handler wins over the patch: an action with both is optimistic in the browser and checked here. */
export function runHandler(ctx: HandlerCtx, def: ActionDef, input: unknown) {
  return handlers[def.name] ? handlers[def.name]!(ctx, input) : runPatch(ctx, def, input)
}
