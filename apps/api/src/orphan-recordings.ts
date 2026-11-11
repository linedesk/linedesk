// Recordings whose file exists but was never reported (the agent died or ran out of time after the
// hang-up) are linked to their call by a sweep, off the path of a new call. The key is derived from
// workspace and call, so this is one lookup per recently finished call without a recording.
// Looks in the store new calls are recorded into (resolved on every sweep, so a switch in the admin
// area applies within a minute); nothing when recording is off.
import { recordingKey, type RecordingStoreName } from '@linedesk/actions'
import { calls, type Tx } from '@linedesk/db'
import { and, desc, eq, gt, isNull } from 'drizzle-orm'
import { activeRecordingStore, type RecordingStore } from './recording-store.ts'

/** How far back, and how many calls per sweep, it looks. */
const WINDOW_MS = 2 * 60 * 60 * 1000
const LIMIT = 50
const SWEEP_EVERY_MS = 60_000

/** Links every recent completed call without a recording whose file is in the store. Returns the linked ids. */
export async function linkOrphanRecordings(
  tx: Tx,
  { name, store }: { name: RecordingStoreName; store: RecordingStore },
  now = new Date(),
): Promise<string[]> {
  const since = new Date(now.getTime() - WINDOW_MS).toISOString()
  const unlinked = await tx
    .select({ id: calls.id, workspace_id: calls.workspace_id })
    .from(calls)
    .where(and(eq(calls.status, 'completed'), isNull(calls.recording_key), gt(calls.ended_at, since)))
    .orderBy(desc(calls.ended_at))
    .limit(LIMIT)
  const linked: string[] = []
  for (const call of unlinked) {
    const key = recordingKey(call.workspace_id, call.id)
    if (!(await store.exists(key))) continue
    const updated = await tx
      .update(calls)
      .set({ recording_key: key, recording_store: name })
      .where(and(eq(calls.id, call.id), isNull(calls.recording_key))) // not if the agent reported it meanwhile
      .returning({ id: calls.id })
    linked.push(...updated.map(u => u.id))
  }
  return linked
}

/** Runs the sweep every minute in the API process while recording is on. Never throws. */
export function startOrphanRecordingSweep(tx: Tx, env: Record<string, string | undefined> = process.env) {
  let lastProblem: string | null = null
  async function sweep() {
    try {
      const active = await activeRecordingStore(tx, env)
      lastProblem = null
      if (!active) return
      const ids = await linkOrphanRecordings(tx, active)
      if (ids.length) console.log(`linked ${ids.length} unreported recording(s): ${ids.join(', ')}`)
    } catch (e) {
      // A store that is not set up is logged once, not every minute.
      const problem = e instanceof Error ? e.message : String(e)
      if (problem !== lastProblem) console.warn(`unreported recordings are not linked: ${problem}`)
      lastProblem = problem
    }
  }
  const timer = setInterval(sweep, SWEEP_EVERY_MS)
  timer.unref()
  void sweep()
  return () => clearInterval(timer)
}
