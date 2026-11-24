// Public demo calls (demo-call.ts) after the token: their rooms are named DEMO_ROOM_PREFIX…, so the stale-call sweep
// can end one that outlives the agent's own time limit (stale-calls.ts), and the hourly cleanup job clears what the visitors
// said once DEMO_TRANSCRIPT_DAYS are over (jobs.ts). A demo call is found by its room in any workspace: the install
// decides which workspace its demo assistants live in (DEMO_ASSISTANTS), and only demo tokens name such rooms.
import { DEMO_CALL_MAX_SECONDS } from '@linedesk/actions'
import {
  call_evaluations,
  call_events,
  calls,
  commands,
  knowledge_questions,
  transcript_segments,
  type Tx,
} from '@linedesk/db'
import { and, eq, exists, inArray, isNotNull, isNull, like, lt, or, sql } from 'drizzle-orm'
import { purgeCommandsAbout } from './command-log.ts'
import { clearCallPayloads } from './webhooks.ts'

type Env = Record<string, string | undefined>

/** Every public demo room starts with this; test calls from the web app use `test-`, phone calls `call-`. */
export const DEMO_ROOM_PREFIX = 'demo-'
export const isDemoRoom = (room: string | null | undefined) => !!room?.startsWith(DEMO_ROOM_PREFIX)
/**
 * A live demo call older than this is ended by the stale-call sweep, room and all: the agent says goodbye at
 * DEMO_CALL_MAX_SECONDS, so this only catches an agent that did not (crashed, stuck).
 */
export const DEMO_ROOM_MAX_MS = (DEMO_CALL_MAX_SECONDS + 30) * 1000

/** Days a demo call's transcript and summary are kept, unless DEMO_TRANSCRIPT_DAYS says otherwise (0: until the next cleanup run). */
export const DEMO_TRANSCRIPT_DAYS = 7
export function demoTranscriptDays(env: Env = process.env) {
  const raw = env.DEMO_TRANSCRIPT_DAYS?.trim()
  const n = raw ? Number(raw) : Number.NaN
  return Number.isInteger(n) && n >= 0 ? n : DEMO_TRANSCRIPT_DAYS
}

/** The command-log action of each demo token (demo-call.ts imports it from here). */
export const DEMO_CALL_TOKEN = 'demo.callToken'

/**
 * Hours a demo token's visitor hash (`ipHash`) is kept in the command log: the per-visitor limits look back a day at
 * most. The cleanup job runs every hour, so a hash is gone at most an hour after this.
 */
export const DEMO_IP_HASH_HOURS = 24

/** Removes the visitor hash from demo tokens older than DEMO_IP_HASH_HOURS; the rest of the row stays. Returns how many. */
export async function stripOldDemoIpHashes(tx: Tx, now = new Date()): Promise<number> {
  const before = new Date(now.getTime() - DEMO_IP_HASH_HOURS * 3_600_000).toISOString()
  const rows = await tx
    .update(commands)
    .set({ input: sql`${commands.input} - 'ipHash'` })
    .where(
      and(eq(commands.action, DEMO_CALL_TOKEN), lt(commands.created_at, before), sql`${commands.input} ? 'ipHash'`),
    )
    .returning({ id: commands.id })
  return rows.length
}

const demoCall = and(eq(calls.source, 'test'), like(calls.room, `${DEMO_ROOM_PREFIX}%`))

/**
 * Clears the demo calls that ended more than `days` ago: their transcript lines, activity, evaluation and the
 * questions they raised are deleted, and the call row keeps only its times and length (the workspace's spending cap
 * counts them) with no title, summary or next steps, marked deleted. The command log about them keeps only ids. Returns
 * the call ids it cleared.
 */
export async function clearOldDemoCalls(tx: Tx, days: number, now = new Date()): Promise<string[]> {
  const before = new Date(now.getTime() - days * 86_400_000).toISOString()
  const hasLines = exists(
    tx.select({ one: sql`1` }).from(transcript_segments).where(eq(transcript_segments.call_id, calls.id)),
  )
  const due = await tx
    .select({ id: calls.id, workspaceId: calls.workspace_id })
    .from(calls)
    .where(
      and(
        demoCall,
        eq(calls.status, 'completed'),
        lt(calls.ended_at, before),
        or(isNull(calls.deleted_at), isNotNull(calls.title), isNotNull(calls.summary), hasLines),
      ),
    )
  if (!due.length) return []
  const ids = due.map(c => c.id)
  await tx.delete(transcript_segments).where(inArray(transcript_segments.call_id, ids))
  await tx.delete(call_events).where(inArray(call_events.call_id, ids))
  await tx.delete(call_evaluations).where(inArray(call_evaluations.call_id, ids))
  await tx.delete(knowledge_questions).where(inArray(knowledge_questions.call_id, ids))
  await tx
    .update(calls)
    .set({
      title: null,
      summary: null,
      action_items: [],
      fields: [],
      caller_details: null,
      deleted_at: sql`coalesce(${calls.deleted_at}, ${now.toISOString()})`,
    })
    .where(inArray(calls.id, ids))
  for (const { id, workspaceId } of due) {
    await clearCallPayloads(tx, workspaceId, id)
    await purgeCommandsAbout(tx, workspaceId, 'callId', id, now)
  }
  return ids
}
