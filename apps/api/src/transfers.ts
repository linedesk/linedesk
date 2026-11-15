// call.transfer: the voice agent asks to start a warm transfer (`dialing`) and reports how it ended.
// The start is where the workspace's limits are kept: TRANSFERS_PER_HOUR started in the last hour,
// and CONCURRENT_TRANSFERS on-call legs ringing or connected at a time. Checked under a per-workspace
// advisory lock, so two calls of the same workspace cannot both slip in. Only phone calls count and are limited,
// like the live-call limit: a test call (browser or the call test's room) never dials a real phone.
// The start is also where the destination is checked again, right before the agent dials: the workspace's numbers or
// the install's list may have changed since the contact was saved (outbound-policy.ts), and the day's minutes of
// transferred calls are counted; the answer tells the agent the caller ID and how long the leg may last.
// And the destination must be one of the saved transfer contacts of the assistant that answered the call: the agent
// only ever dials those, so any other number (a forged or confused request) is refused and logged.
// Only while the business is open for that contact (`hours_only`), and never in closure mode.
// Each result also closes the leg it ends (only the open leg's own number: a late result of an earlier try is ignored): its seconds go into `transfer_seconds`, so a call that tried several contacts
// counts every leg toward the day's minutes, not only the last one (outbound-policy.ts, transferMinutesUsed).
import {
  CONCURRENT_TRANSFERS,
  type CallTransferData,
  isActiveContact,
  normalizeCallerId,
  type TransferResult,
  TRANSFERS_PER_HOUR,
} from '@linedesk/actions'
import { type Call, calls, type Tx } from '@linedesk/db'
import { and, eq, gte, inArray, ne, sql } from 'drizzle-orm'
import { assistantForNumber } from './assistants.ts'
import { type Handler, type HandlerCtx, Reject } from './handler-context.ts'
import {
  numberRoute,
  outboundCallerId,
  outboundLimits,
  outboundRefusal,
  transferMinutesAllowed,
} from './outbound-policy.ts'

const HOUR_MS = 60 * 60 * 1000

type Input = { callId: string; to: string; result: TransferResult; name?: string; urgent?: boolean }

/** The business hours `call.start` gives the agent (handlers.ts, businessHoursFor); null: none to keep. */
export type HoursFor = (
  tx: Tx,
  workspaceId: string,
  now: string,
) => Promise<{ openNow: boolean; closure?: unknown } | null>

/** call.transfer; `hoursFor` reads the business hours, which a contact limited to them is checked against. */
export function transferHandlers(hoursFor: HoursFor): Record<string, Handler> {
  return { 'call.transfer': (ctx, input: Input) => callTransfer(ctx, input, hoursFor) }
}

async function callTransfer({ tx, actor, now }: HandlerCtx, input: Input, hoursFor: HoursFor) {
  const workspaceId = actor.workspaceId
  if (!workspaceId) throw new Reject('no workspace (send x-workspace-id)')
  // Locked: a result and the next dial of the same call never interleave (a late result cannot end the next leg).
  const [call] = await tx
    .select()
    .from(calls)
    .where(and(eq(calls.id, input.callId), eq(calls.workspace_id, workspaceId)))
    .for('update')
  if (!call) throw new Reject('call not found')
  // A transfer never changes the call's urgency (`urgent` from an older agent is ignored).
  const transfer_name = input.name ?? null
  if (input.result !== 'dialing') {
    const sameNumber = !!call.transfer_to && normalizeCallerId(call.transfer_to) === normalizeCallerId(input.to)
    if (legOpen(call) && !sameNumber) {
      // A late result of an earlier try (or of a number never dialled): the open leg is another one's, left as it is.
      console.warn(`transfer of call ${call.id}: a ${input.result} result does not match the open leg; ignored`)
      return { rows: { calls: [call] } }
    }
    if (input.result === 'connected' && !legOpen(call)) {
      // Put through without a dial: never takes the one-leg slot or changes the number.
      console.warn(`transfer of call ${call.id}: connected without a dial; ignored`)
      return { rows: { calls: [call] } }
    }
    const rows = await tx
      .update(calls)
      .set({
        transfer_to: input.to,
        transfer_name,
        transfer_result: input.result,
        // `connected` keeps the leg open (counted to the call's end); every other result ends it.
        ...(input.result === 'connected' ? {} : { transfer_seconds: closedLegSeconds(call, now) }),
      })
      .where(eq(calls.id, call.id))
      .returning()
    return { rows: { calls: rows } }
  }
  // Every call, test calls too: a destination the workspace may not call is never dialled. The countries are those
  // of the route the call goes out through: the account the called number is in (transfer-trunk.ts).
  const route = await numberRoute(tx, workspaceId, call.to_number)
  const refusal = await outboundRefusal(tx, workspaceId, input.to, 'transfer', { strict: true, route })
  if (refusal) {
    console.warn(`transfer of call ${call.id} refused: the destination is not allowed for workspace ${workspaceId}`)
    throw new Reject(`transfer refused: ${refusal}`)
  }
  if (call.source !== 'test') {
    // Test calls are not checked: they dial no real phone and carry the call test's own contacts and hours.
    const contacts = await savedTransferContacts(tx, workspaceId, call.assistant_id, input.to)
    if (!contacts.length) {
      console.warn(
        `transfer of call ${call.id} refused: the destination is not a saved transfer contact of workspace ${workspaceId}`,
      )
      throw new Reject("transfer refused: the number is not one of the assistant's transfer contacts")
    }
    // As the agent picks the contacts (transferContactsFor): nobody in closure mode, "only during business hours" ones
    // only while open.
    const hours = await hoursFor(tx, workspaceId, now)
    const closed = !!hours && !hours.openNow
    if (hours?.closure || (closed && contacts.every(c => c.hours_only))) {
      console.warn(`transfer of call ${call.id} refused: the business is closed for this transfer contact`)
      throw new Reject('transfer refused: this transfer contact takes calls only while the business is open')
    }
  }
  let maxMinutes = outboundLimits().transferMaxMinutes
  if (!maxMinutes) throw new Reject('transfers are off on this server')
  if (call.source === 'phone') {
    await checkTransferLimits(tx, workspaceId, call.id, now)
    maxMinutes = await transferMinutesAllowed(tx, workspaceId, now, route)
  }
  const rows = await tx
    .update(calls)
    .set({
      transfer_to: input.to,
      transfer_name,
      transfer_result: 'dialing',
      transfer_at: now,
      // A leg whose result never came (the agent's report was lost) ends where the next one starts.
      transfer_seconds: closedLegSeconds(call, now),
    })
    .where(eq(calls.id, call.id))
    .returning()
  const callerId = await outboundCallerId(tx, workspaceId, call.to_number, input.to)
  return { rows: { calls: rows }, data: { callerId, maxMinutes } satisfies CallTransferData }
}

/** Whether a leg of this call is open: dialled and not ended by a result other than `connected`. */
const legOpen = (call: Pick<Call, 'transfer_result' | 'transfer_at'>) =>
  !!call.transfer_at && (call.transfer_result === 'dialing' || call.transfer_result === 'connected')

/**
 * The call's `transfer_seconds` once its open leg ends at `now` (at the call's end when that came first): the seconds
 * from that leg's dial added, ringing included (as the day's minutes count it). Unchanged when no leg is open (a contact
 * that could not be dialled, a second result for the same leg).
 */
export function closedLegSeconds(
  call: Pick<Call, 'transfer_result' | 'transfer_at' | 'transfer_seconds' | 'ended_at'>,
  now: string,
) {
  if (!legOpen(call)) return call.transfer_seconds
  const end = Math.min(Date.parse(now), call.ended_at ? Date.parse(call.ended_at) : Number.POSITIVE_INFINITY)
  const seconds = Math.ceil((end - Date.parse(call.transfer_at!)) / 1000)
  return call.transfer_seconds + Math.max(0, seconds)
}

/**
 * The active transfer contacts with the number `to` of the assistant that answered the call (the call's, else the
 * workspace's first, as the agent picks it): the only numbers the agent dials. Matched as E.164.
 */
async function savedTransferContacts(tx: Tx, workspaceId: string, assistantId: string | null, to: string) {
  const assistant = await assistantForNumber(tx, workspaceId, assistantId)
  const wanted = normalizeCallerId(to)
  return (assistant?.transfers ?? []).filter(c => isActiveContact(c) && normalizeCallerId(c.number!) === wanted)
}

/** Refuses a new transfer above TRANSFERS_PER_HOUR started in the last hour or CONCURRENT_TRANSFERS legs at a time (phone calls only). */
async function checkTransferLimits(tx: Tx, workspaceId: string, callId: string, now: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`transfer:${workspaceId}`}))`)
  const since = new Date(Date.parse(now) - HOUR_MS).toISOString()
  const [{ count: lastHour }] = (await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(calls)
    .where(and(eq(calls.workspace_id, workspaceId), eq(calls.source, 'phone'), gte(calls.transfer_at, since)))) as [
    { count: number },
  ]
  if (lastHour >= TRANSFERS_PER_HOUR) throw new Reject(`transfer limit reached: ${TRANSFERS_PER_HOUR} an hour`)
  const [{ count: active }] = (await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(calls)
    .where(
      and(
        eq(calls.workspace_id, workspaceId),
        eq(calls.source, 'phone'),
        eq(calls.status, 'live'),
        inArray(calls.transfer_result, ['dialing', 'connected']),
        ne(calls.id, callId),
      ),
    )) as [{ count: number }]
  if (active >= CONCURRENT_TRANSFERS) throw new Reject('another transfer of this workspace is in progress')
}
