// A live call whose agent went away (crash, deploy, lost connection) never gets call.finish and would
// sit at the top of the inbox as "live" forever. The API ends such calls once nothing has happened on
// them for a while, and files them honestly: cut off, with a callback when the caller had spoken. Their LiveKit
// room is deleted too: a caller still on an open line is hung up on, and an agent stuck in it stops.
import { CALL_MAX_MINUTES } from '@linedesk/actions'
import { calls, transcript_segments, type Tx } from '@linedesk/db'
import { and, eq, inArray, lt, sql } from 'drizzle-orm'
import { deleteLivekitRoom } from './livekit-status.ts'

/** Minutes without a new transcript line after which a live call counts as over. */
export const STALE_AFTER_MIN = Number(process.env.STALE_LIVE_CALL_MINUTES) || 10
const SWEEP_EVERY_MS = 60_000
/**
 * A call put through to a person has no transcript lines after the transfer, and may run up to CALL_MAX_MINUTES:
 * it counts as over only after that (and a margin), so the sweep never hangs up on the caller and the person.
 */
const TRANSFERRED_STALE_MS = (CALL_MAX_MINUTES + 5) * 60_000

type Activity = { id: string; started_at: string; last_ms: number | null; caller_turns: number; transferred: boolean }

/** Live calls that started before the cutoff, with the time of their last transcript line. */
async function liveCallsStartedBefore(tx: Tx, cutoff: string): Promise<Activity[]> {
  return tx
    .select({
      id: calls.id,
      started_at: calls.started_at,
      last_ms: sql<number | null>`max(${transcript_segments.at_ms})`,
      caller_turns: sql<number>`count(*) filter (where ${transcript_segments.speaker} = 'caller')`.mapWith(Number),
      transferred: sql<boolean>`${calls.transfer_result} = 'connected'`.mapWith(Boolean),
    })
    .from(calls)
    .leftJoin(transcript_segments, eq(transcript_segments.call_id, calls.id))
    .where(and(eq(calls.status, 'live'), lt(calls.started_at, cutoff)))
    .groupBy(calls.id)
}

/** What a cut-off call says in the inbox: a person calls back when the caller had said something. */
export function cutOffResult(callerSpoke: boolean) {
  return callerSpoke
    ? {
        outcome: 'callback' as const,
        title: 'Call cut off',
        summary:
          'The call ended before the assistant could wrap it up, so there is no summary. Read the transcript and call back.',
        action_items: [{ text: 'Call back' }],
      }
    : {
        outcome: 'hangup' as const,
        title: 'Call cut off',
        summary: 'The call ended before the caller said anything.',
        action_items: [],
      }
}

type EndRoom = (room: string) => Promise<boolean>

/** Deletes the room; a failure is logged, never thrown (the call is filed either way). */
async function endRoomQuietly(endRoom: EndRoom, room: string) {
  try {
    if (!(await endRoom(room))) console.warn(`stale call sweep: LiveKit room ${room} could not be deleted`)
  } catch (e) {
    console.warn(`stale call sweep: LiveKit room ${room} could not be deleted: ${e instanceof Error ? e.message : String(e)}`)
  }
}

/**
 * Ends every live call with no activity for `staleAfterMin` minutes, and deletes its LiveKit room (`endRoom`).
 * Returns the ids it ended.
 */
export async function finishStaleCalls(tx: Tx, now = new Date(), staleAfterMin = STALE_AFTER_MIN, endRoom: EndRoom = room => deleteLivekitRoom(room)): Promise<string[]> {
  const staleMs = staleAfterMin * 60_000
  const cutoff = new Date(now.getTime() - staleMs).toISOString()
  const ended: string[] = []
  for (const call of await liveCallsStartedBefore(tx, cutoff)) {
    const startedMs = Date.parse(call.started_at)
    const lastActivityMs = startedMs + (call.last_ms ?? 0)
    if (now.getTime() - lastActivityMs < staleMs) continue
    if (call.transferred && now.getTime() - startedMs < TRANSFERRED_STALE_MS) continue
    const { action_items, ...result } = cutOffResult(call.caller_turns > 0)
    const updated = await tx
      .update(calls)
      .set({
        status: 'completed',
        ended_at: new Date(lastActivityMs).toISOString(),
        duration_sec: Math.round((call.last_ms ?? 0) / 1000),
        ...result,
        // Keep anything the call already had (a title or next steps the assistant saved).
        title: sql`coalesce(${calls.title}, ${result.title})`,
        action_items: sql`case when jsonb_array_length(${calls.action_items}) > 0 then ${calls.action_items} else ${JSON.stringify(action_items)}::jsonb end`,
      })
      .where(and(inArray(calls.id, [call.id]), eq(calls.status, 'live'))) // not if call.finish arrived meanwhile
      .returning({ id: calls.id, room: calls.room })
    for (const { id, room } of updated) {
      ended.push(id)
      if (room) await endRoomQuietly(endRoom, room)
    }
  }
  return ended
}

/** Runs the sweep every minute in the API process. Never throws. */
export function startStaleCallSweep(tx: Tx) {
  const sweep = () =>
    finishStaleCalls(tx)
      .then(ids => ids.length && console.log(`ended ${ids.length} stale live call(s): ${ids.join(', ')}`))
      .catch(e => console.error('stale call sweep failed', e))
  const timer = setInterval(sweep, SWEEP_EVERY_MS)
  timer.unref()
  void sweep()
  return () => clearInterval(timer)
}
