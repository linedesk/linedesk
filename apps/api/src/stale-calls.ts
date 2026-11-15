// A live call whose agent went away (crash, deploy, lost connection) never gets call.finish and would
// sit at the top of the inbox as "live" forever. The API ends such calls, and files them honestly: cut off, with a
// callback when the caller had spoken. Each sweep asks LiveKit once which rooms are open: a call whose room is gone
// and that has been quiet for a minute is over at once; a call whose room is still open is never ended. Only when
// LiveKit cannot be asked does the sweep fall back to time alone (10 minutes of quiet, 2 for a test call), and then
// deletes the call's room too: a caller still on an open line is hung up on, and an agent stuck in it stops.
import { CALL_MAX_MINUTES } from '@linedesk/actions'
import { calls, transcript_segments, type Tx } from '@linedesk/db'
import { and, eq, inArray, lt, sql } from 'drizzle-orm'
import { deleteLivekitRoom, listLivekitRooms } from './livekit-status.ts'

/** Minutes without a new transcript line after which a live call counts as over, when LiveKit cannot be asked. */
export const STALE_AFTER_MIN = Number(process.env.STALE_LIVE_CALL_MINUTES) || 10
/** The same for a test call from the browser: nobody is on it once the browser has left. */
export const TEST_STALE_AFTER_MIN = 2
/** Quiet time after which a call whose LiveKit room is gone counts as over. */
export const ROOM_GONE_QUIET_MS = 60_000
const SWEEP_EVERY_MS = 60_000
/**
 * A call put through to a person has no transcript lines after the transfer, and may run up to CALL_MAX_MINUTES:
 * it counts as over only after that (and a margin), so the sweep never hangs up on the caller and the person.
 */
const TRANSFERRED_STALE_MS = (CALL_MAX_MINUTES + 5) * 60_000
/** Calls that run in a LiveKit room. Simulated and sample calls name a room that LiveKit never had. */
const IN_LIVEKIT: readonly string[] = ['phone', 'test']

type Activity = {
  id: string
  started_at: string
  last_ms: number | null
  caller_turns: number
  transferred: boolean
  room: string | null
  source: string
}

/** Live calls that started before the cutoff, with the time of their last transcript line. */
async function liveCallsStartedBefore(tx: Tx, cutoff: string): Promise<Activity[]> {
  return tx
    .select({
      id: calls.id,
      started_at: calls.started_at,
      last_ms: sql<number | null>`max(${transcript_segments.at_ms})`,
      caller_turns: sql<number>`count(*) filter (where ${transcript_segments.speaker} = 'caller')`.mapWith(Number),
      transferred: sql<boolean>`${calls.transfer_result} = 'connected'`.mapWith(Boolean),
      room: calls.room,
      source: calls.source,
    })
    .from(calls)
    .leftJoin(transcript_segments, eq(transcript_segments.call_id, calls.id))
    .where(and(eq(calls.status, 'live'), lt(calls.started_at, cutoff)))
    .groupBy(calls.id)
}

/** A call quiet this long counts as having talked, even when none of the caller's lines reached the API. */
const TALKED_MS = 20_000

/**
 * What a cut-off call says in the inbox. A person calls back only when a caller line exists. A call that ran for a
 * while without one lost its transcript (the agent could not reach the API), so it does not claim the caller was silent.
 */
export function cutOffResult(callerTurns: number, durationMs: number) {
  if (callerTurns > 0) {
    return {
      outcome: 'callback' as const,
      title: 'Call cut off',
      summary:
        'The call ended before the assistant could wrap it up, so there is no summary. Read the transcript and call back.',
      action_items: [{ text: 'Call back' }],
    }
  }
  return {
    outcome: 'hangup' as const,
    title: 'Call cut off',
    summary:
      durationMs > TALKED_MS
        ? 'The call ended before it was wrapped up, and its transcript was not saved.'
        : 'The call ended before the caller said anything.',
    action_items: [],
  }
}

type EndRoom = (room: string) => Promise<boolean>
/** The open LiveKit rooms, or null when LiveKit cannot be asked. */
type ListRooms = () => Promise<Set<string> | null>

/** Deletes the room; a failure is logged, never thrown (the call is filed either way). */
async function endRoomQuietly(endRoom: EndRoom, room: string) {
  try {
    if (!(await endRoom(room))) console.warn(`stale call sweep: LiveKit room ${room} could not be deleted`)
  } catch (e) {
    console.warn(`stale call sweep: LiveKit room ${room} could not be deleted: ${e instanceof Error ? e.message : String(e)}`)
  }
}

/** Reads the open rooms; a failure counts as "LiveKit cannot be asked" (null), never thrown. */
async function openRooms(listRooms: ListRooms): Promise<Set<string> | null> {
  try {
    return await listRooms()
  } catch {
    return null
  }
}

type Verdict = 'live' | 'room-gone' | 'quiet'

/**
 * Whether a live call is over. A call whose LiveKit room is open stays live; one whose room is gone is over after a
 * minute of quiet. Without an answer from LiveKit (or for a call that has no LiveKit room) only the quiet time counts.
 */
function verdict(call: Activity, rooms: Set<string> | null, nowMs: number, staleAfterMin: number): Verdict {
  const startedMs = Date.parse(call.started_at)
  const quietMs = nowMs - (startedMs + (call.last_ms ?? 0))
  if (call.transferred && nowMs - startedMs < TRANSFERRED_STALE_MS) return 'live'
  if (rooms && call.room && IN_LIVEKIT.includes(call.source)) {
    if (rooms.has(call.room)) return 'live'
    return quietMs >= ROOM_GONE_QUIET_MS ? 'room-gone' : 'live'
  }
  const limitMin = call.source === 'test' ? Math.min(TEST_STALE_AFTER_MIN, staleAfterMin) : staleAfterMin
  return quietMs >= limitMin * 60_000 ? 'quiet' : 'live'
}

export type SweepOptions = {
  now?: Date
  /** Quiet minutes before a call counts as over when LiveKit cannot be asked. */
  staleAfterMin?: number
  /** Deletes a LiveKit room (replaced in tests). */
  endRoom?: EndRoom
  /** Lists the open LiveKit rooms (replaced in tests). */
  listRooms?: ListRooms
}

/** Ends every live call that is over (see `verdict`), and deletes its LiveKit room when it may still be open. Returns the ids it ended. */
export async function finishStaleCalls(
  tx: Tx,
  {
    now = new Date(),
    staleAfterMin = STALE_AFTER_MIN,
    endRoom = room => deleteLivekitRoom(room),
    listRooms = () => listLivekitRooms(),
  }: SweepOptions = {},
): Promise<string[]> {
  const nowMs = now.getTime()
  const candidates = await liveCallsStartedBefore(tx, new Date(nowMs - ROOM_GONE_QUIET_MS).toISOString())
  if (!candidates.length) return []
  const rooms = candidates.some(c => c.room && IN_LIVEKIT.includes(c.source)) ? await openRooms(listRooms) : null
  const ended: string[] = []
  for (const call of candidates) {
    const over = verdict(call, rooms, nowMs, staleAfterMin)
    if (over === 'live') continue
    const startedMs = Date.parse(call.started_at)
    const lastActivityMs = startedMs + (call.last_ms ?? 0)
    const { action_items, ...result } = cutOffResult(call.caller_turns, call.last_ms ?? 0)
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
      // A room LiveKit no longer has needs no delete; without an answer from LiveKit it may still be open.
      if (room && over === 'quiet') await endRoomQuietly(endRoom, room)
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
