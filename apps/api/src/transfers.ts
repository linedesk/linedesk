// call.transfer: the voice agent asks to start a warm transfer (`dialing`) and reports how it ended.
// The start is where the workspace's limits are kept: TRANSFERS_PER_HOUR started in the last hour,
// and CONCURRENT_TRANSFERS on-call legs ringing or connected at a time. Checked under a per-workspace
// advisory lock, so two calls of the same workspace cannot both slip in.
import { CONCURRENT_TRANSFERS, type TransferResult, TRANSFERS_PER_HOUR } from '@linedesk/actions'
import { calls } from '@linedesk/db'
import { and, eq, gte, inArray, ne, sql } from 'drizzle-orm'
import { type Handler, Reject } from './handler-context.ts'

const HOUR_MS = 60 * 60 * 1000

type Input = { callId: string; to: string; result: TransferResult }

export const transferHandlers: Record<string, Handler> = {
  'call.transfer': async ({ tx, actor, now }, input: Input) => {
    const workspaceId = actor.workspaceId
    if (!workspaceId) throw new Reject('no workspace (send x-workspace-id)')
    const [call] = await tx
      .select()
      .from(calls)
      .where(and(eq(calls.id, input.callId), eq(calls.workspace_id, workspaceId)))
    if (!call) throw new Reject('call not found')
    if (input.result !== 'dialing') {
      const rows = await tx
        .update(calls)
        .set({ transfer_to: input.to, transfer_result: input.result, urgency: 'urgent' })
        .where(eq(calls.id, call.id))
        .returning()
      return { rows: { calls: rows } }
    }
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`transfer:${workspaceId}`}))`)
    const since = new Date(Date.parse(now) - HOUR_MS).toISOString()
    const [{ count: lastHour }] = (await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(calls)
      .where(and(eq(calls.workspace_id, workspaceId), gte(calls.transfer_at, since)))) as [{ count: number }]
    if (lastHour >= TRANSFERS_PER_HOUR) throw new Reject(`transfer limit reached: ${TRANSFERS_PER_HOUR} an hour`)
    const [{ count: active }] = (await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(calls)
      .where(
        and(
          eq(calls.workspace_id, workspaceId),
          eq(calls.status, 'live'),
          inArray(calls.transfer_result, ['dialing', 'connected']),
          ne(calls.id, call.id),
        ),
      )) as [{ count: number }]
    if (active >= CONCURRENT_TRANSFERS) throw new Reject('another transfer of this workspace is in progress')
    const rows = await tx
      .update(calls)
      .set({ transfer_to: input.to, transfer_result: 'dialing', transfer_at: now, urgency: 'urgent' })
      .where(eq(calls.id, call.id))
      .returning()
    return { rows: { calls: rows } }
  },
}
