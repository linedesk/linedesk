// call.transfer: the voice agent asks to start a warm transfer (`dialing`) and reports how it ended.
// The start is where the workspace's limits are kept: TRANSFERS_PER_HOUR started in the last hour,
// and CONCURRENT_TRANSFERS on-call legs ringing or connected at a time. Checked under a per-workspace
// advisory lock, so two calls of the same workspace cannot both slip in. Only phone calls count and are limited,
// like the live-call limit: a test call (browser or the call test's room) never dials a real phone.
// The start is also where the destination is checked again, right before the agent dials: the workspace's numbers or
// the install's list may have changed since the contact was saved (outbound-policy.ts), and the day's minutes of
// transferred calls are counted; the answer tells the agent the caller ID and how long the leg may last.
import { CONCURRENT_TRANSFERS, type CallTransferData, type TransferResult, TRANSFERS_PER_HOUR } from '@linedesk/actions'
import { calls, type Tx } from '@linedesk/db'
import { and, eq, gte, inArray, ne, sql } from 'drizzle-orm'
import { type Handler, Reject } from './handler-context.ts'
import { numberRoute, outboundCallerId, outboundLimits, outboundRefusal, transferMinutesAllowed } from './outbound-policy.ts'

const HOUR_MS = 60 * 60 * 1000

type Input = { callId: string; to: string; result: TransferResult; name?: string; urgent?: boolean }

export const transferHandlers: Record<string, Handler> = {
  'call.transfer': async ({ tx, actor, now }, input: Input) => {
    const workspaceId = actor.workspaceId
    if (!workspaceId) throw new Reject('no workspace (send x-workspace-id)')
    const [call] = await tx
      .select()
      .from(calls)
      .where(and(eq(calls.id, input.callId), eq(calls.workspace_id, workspaceId)))
    if (!call) throw new Reject('call not found')
    // A transfer never changes the call's urgency (`urgent` from an older agent is ignored).
    const transfer_name = input.name ?? null
    if (input.result !== 'dialing') {
      const rows = await tx
        .update(calls)
        .set({ transfer_to: input.to, transfer_name, transfer_result: input.result })
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
    let maxMinutes = outboundLimits().transferMaxMinutes
    if (!maxMinutes) throw new Reject('transfers are off on this server')
    if (call.source === 'phone') {
      await checkTransferLimits(tx, workspaceId, call.id, now)
      maxMinutes = await transferMinutesAllowed(tx, workspaceId, now, route)
    }
    const rows = await tx
      .update(calls)
      .set({ transfer_to: input.to, transfer_name, transfer_result: 'dialing', transfer_at: now })
      .where(eq(calls.id, call.id))
      .returning()
    const callerId = await outboundCallerId(tx, workspaceId, call.to_number, input.to)
    return { rows: { calls: rows }, data: { callerId, maxMinutes } satisfies CallTransferData }
  },
}

/** Refuses a new transfer above TRANSFERS_PER_HOUR started in the last hour or CONCURRENT_TRANSFERS legs at a time (phone calls only). */
async function checkTransferLimits(tx: Tx, workspaceId: string, callId: string, now: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`transfer:${workspaceId}`}))`)
  const since = new Date(Date.parse(now) - HOUR_MS).toISOString()
  const [{ count: lastHour }] = (await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(calls)
    .where(and(eq(calls.workspace_id, workspaceId), eq(calls.source, 'phone'), gte(calls.transfer_at, since)))) as [{ count: number }]
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
