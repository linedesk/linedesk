// call.transfer: the voice agent asks to start a warm transfer (`dialing`) and reports how it ended.
// The start is where the workspace's limits are kept: TRANSFERS_PER_HOUR started in the last hour,
// and CONCURRENT_TRANSFERS on-call legs ringing or connected at a time. Checked under a per-workspace
// advisory lock, so two calls of the same workspace cannot both slip in. Only phone calls count and are limited,
// like the live-call limit: a test call (browser or the call test's room) never dials a real phone.
import { CONCURRENT_TRANSFERS, type TransferResult, TRANSFERS_PER_HOUR } from '@linedesk/actions'
import { calls, type Tx } from '@linedesk/db'
import { and, eq, gte, inArray, ne, sql } from 'drizzle-orm'
import { type Handler, Reject } from './handler-context.ts'

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
    // A transfer that is not about an emergency (billing, asks for a person) keeps the call's urgency.
    const urgency = input.urgent === false ? {} : { urgency: 'urgent' as const }
    const transfer_name = input.name ?? null
    if (input.result !== 'dialing') {
      const rows = await tx
        .update(calls)
        .set({ transfer_to: input.to, transfer_name, transfer_result: input.result, ...urgency })
        .where(eq(calls.id, call.id))
        .returning()
      return { rows: { calls: rows } }
    }
    if (call.source === 'phone') await checkTransferLimits(tx, workspaceId, call.id, now)
    const rows = await tx
      .update(calls)
      .set({ transfer_to: input.to, transfer_name, transfer_result: 'dialing', transfer_at: now, ...urgency })
      .where(eq(calls.id, call.id))
      .returning()
    return { rows: { calls: rows } }
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
