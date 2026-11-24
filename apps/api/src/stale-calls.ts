// A live call whose agent went away (crash, deploy, lost connection) never gets call.finish and would
// sit at the top of the inbox as "live" forever. The API ends such calls, and files them honestly: cut off, with a
// callback when the caller had spoken. Each sweep asks LiveKit once which rooms are open and who is in them: a call
// whose room is gone or empty and that has been quiet for a minute is over at once; a call with someone in its room is
// never ended. An empty room is deleted: LiveKit keeps the room of a dead agent open, with nobody in it. Only when
// LiveKit cannot be asked does the sweep fall back to time alone (10 minutes of quiet, 2 for a test call), and then
// deletes the call's room too: a caller still on an open line is hung up on, and an agent stuck in it stops.
// A public demo call (demo-call.ts) is ended, room and all, once it is older than DEMO_ROOM_MAX_MS, whoever is in it:
// the agent says goodbye earlier, so this only catches one that did not. Its room is deleted first, and the call is
// filed only once that worked: while LiveKit cannot delete it, the call stays live (and counted) for the next sweep.
// A billed call (Linedesk Cloud, call-billing.ts) still live after its limit plus the grace is ended the same way, at
// once, whoever is in its room: filed with its full length while someone is in its room or LiveKit cannot be asked,
// else with its last activity (a bridged call: at most the billed transfer cap after the transfer), so a call that
// ended unreported is not billed its whole limit (security review of #864, L1). Then every ended call whose usage has
// not posted yet (this sweep's, or a finish whose post failed) is posted. An ended call queues the after-call webhook
// and Zapier's call_finished, like call.finish.
import { CALL_MAX_MINUTES } from '@linedesk/actions'
import { calls, transcript_segments, type Tx } from '@linedesk/db'
import { and, eq, inArray, lt, sql } from 'drizzle-orm'
import { billingRules } from './billing-rules.ts'
import { callsPastTheirLimit, postEndedCalls } from './call-billing.ts'
import { DEMO_ROOM_MAX_MS, isDemoRoom } from './demo-rooms.ts'
import { queueIntegrationDeliveries } from './integrations.ts'
import { queueAppPushes } from './app-pushes.ts'
import { deleteLivekitRoom, listLivekitRooms } from './livekit-status.ts'
import { queueCallEnd } from './webhooks.ts'

/** Minutes without a new transcript line after which a live call counts as over, when LiveKit cannot be asked. */
export const STALE_AFTER_MIN = Number(process.env.STALE_LIVE_CALL_MINUTES) || 10
/** The same for a test call from the browser: nobody is on it once the browser has left. */
export const TEST_STALE_AFTER_MIN = 2
/** Quiet time after which a call whose LiveKit room is gone or empty counts as over. */
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
  transfer_at: string | null
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
      transfer_at: calls.transfer_at,
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
/** The open LiveKit rooms with how many participants are in each, or null when LiveKit cannot be asked. */
type ListRooms = () => Promise<Map<string, number> | null>

/** Deletes the room; a failure is logged, never thrown (the call is filed either way). */
async function endRoomQuietly(endRoom: EndRoom, room: string) {
  try {
    if (!(await endRoom(room))) console.warn(`stale call sweep: LiveKit room ${room} could not be deleted`)
  } catch (e) {
    console.warn(`stale call sweep: LiveKit room ${room} could not be deleted: ${e instanceof Error ? e.message : String(e)}`)
  }
}

/** Deletes the room; whether it is gone now (deleted, or LiveKit no longer had it). A failure is logged, never thrown. */
async function roomDeleted(endRoom: EndRoom, room: string): Promise<boolean> {
  try {
    if (await endRoom(room)) return true
    console.warn(`stale call sweep: LiveKit room ${room} could not be deleted; trying again next sweep`)
  } catch (e) {
    console.warn(
      `stale call sweep: LiveKit room ${room} could not be deleted (trying again next sweep): ${e instanceof Error ? e.message : String(e)}`,
    )
  }
  return false
}

/** Reads the open rooms; a failure counts as "LiveKit cannot be asked" (null), never thrown. */
async function openRooms(listRooms: ListRooms): Promise<Map<string, number> | null> {
  try {
    return await listRooms()
  } catch {
    return null
  }
}

type Verdict = 'live' | 'room-gone' | 'room-empty' | 'quiet' | 'demo-over' | 'over-limit'

/**
 * Whether a live call is over. A call with someone in its LiveKit room stays live; one whose room is gone or empty is
 * over after a minute of quiet (a dead agent leaves its room open and empty: the call ended, LIN-277). Without an
 * answer from LiveKit (or for a call that has no LiveKit room) only the quiet time counts.
 */
function verdict(
  call: Activity,
  rooms: Map<string, number> | null,
  nowMs: number,
  staleAfterMin: number,
  pastLimit: Set<string>,
): Verdict {
  const startedMs = Date.parse(call.started_at)
  const quietMs = nowMs - (startedMs + (call.last_ms ?? 0))
  if (pastLimit.has(call.id)) return 'over-limit'
  if (call.source === 'test' && isDemoRoom(call.room) && nowMs - startedMs > DEMO_ROOM_MAX_MS) return 'demo-over'
  if (call.transferred && nowMs - startedMs < TRANSFERRED_STALE_MS) return 'live'
  if (rooms && call.room && IN_LIVEKIT.includes(call.source)) {
    const inRoom = rooms.get(call.room)
    if (inRoom) return 'live'
    if (quietMs < ROOM_GONE_QUIET_MS) return 'live'
    return inRoom === undefined ? 'room-gone' : 'room-empty'
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
  const ended = await endStaleCalls(tx, nowMs, staleAfterMin, endRoom, listRooms)
  await postEndedCalls(tx, now.toISOString())
  return ended
}

async function endStaleCalls(tx: Tx, nowMs: number, staleAfterMin: number, endRoom: EndRoom, listRooms: ListRooms) {
  const candidates = await liveCallsStartedBefore(tx, new Date(nowMs - ROOM_GONE_QUIET_MS).toISOString())
  if (!candidates.length) return []
  const rooms = candidates.some(c => c.room && IN_LIVEKIT.includes(c.source)) ? await openRooms(listRooms) : null
  const pastLimit = new Set((await callsPastTheirLimit(tx, new Date(nowMs).toISOString())).map(c => c.id))
  const ended: string[] = []
  for (const call of candidates) {
    const over = verdict(call, rooms, nowMs, staleAfterMin, pastLimit)
    if (over === 'live') continue
    // A demo room may still hold a stuck agent, a call past its limit is still running at the carrier: end the room
    // before filing the call, or leave the call live until it can be.
    if ((over === 'demo-over' || over === 'over-limit') && call.room && !(await roomDeleted(endRoom, call.room)))
      continue
    const startedMs = Date.parse(call.started_at)
    const quietSinceMs = startedMs + (call.last_ms ?? 0)
    // A call past its limit with someone in its room (or LiveKit not answering) ran until now (rating caps it at the
    // limit plus the grace); one whose room is gone or empty, and any other, ended when it went quiet.
    const lastActivityMs =
      over === 'over-limit' && !roomGoneOrEmpty(call, rooms)
        ? nowMs
        : over === 'over-limit' && call.transferred && call.transfer_at
          ? Math.min(nowMs, Math.max(quietSinceMs, Date.parse(call.transfer_at) + (await transferCapMs(tx))))
          : quietSinceMs
    const { action_items, ...result } = cutOffResult(call.caller_turns, call.last_ms ?? 0)
    const updated = await tx
      .update(calls)
      .set({
        status: 'completed',
        ended_at: new Date(lastActivityMs).toISOString(),
        duration_sec: Math.round((lastActivityMs - startedMs) / 1000),
        ...result,
        // Keep anything the call already had (a title or next steps the assistant saved).
        title: sql`coalesce(${calls.title}, ${result.title})`,
        action_items: sql`case when jsonb_array_length(${calls.action_items}) > 0 then ${calls.action_items} else ${JSON.stringify(action_items)}::jsonb end`,
      })
      .where(and(inArray(calls.id, [call.id]), eq(calls.status, 'live'))) // not if call.finish arrived meanwhile
      .returning()
    for (const row of updated) {
      const { id, room } = row
      ended.push(id)
      // A cut-off call is still a finished call for the after-call webhook and Zapier's call_finished, as with
      // call.finish: a deploy or a crashed agent must not hide a caller who wants a callback from them.
      await queueCallEnd(tx, row)
      await queueIntegrationDeliveries(tx, row)
      await queueAppPushes(tx, row)
      // A room LiveKit no longer has needs no delete. An empty one is closed, so a restarted agent does not take its
      // job up again; without an answer from LiveKit it may still be open.
      if (room && over !== 'room-gone' && over !== 'demo-over' && over !== 'over-limit')
        await endRoomQuietly(endRoom, room)
    }
  }
  return ended
}

/** Whether LiveKit answered that the call's room is gone or has nobody in it. */
function roomGoneOrEmpty(call: Activity, rooms: Map<string, number> | null) {
  return !!rooms && !!call.room && IN_LIVEKIT.includes(call.source) && !rooms.get(call.room)
}

/** The longest a billed call stays bridged after its transfer (billing rules), in ms. */
async function transferCapMs(tx: Tx) {
  return (await billingRules(tx)).billedTransferCapSeconds * 1000
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
