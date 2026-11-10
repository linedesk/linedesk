// Recordings whose file exists but was never reported (the agent died or ran out of time after the
// hang-up) are linked to their call by a sweep, off the path of a new call. The key is derived from
// workspace and call, so this is one lookup per recently finished call without a recording.
import { recordingKey } from '@callfront/actions'
import { calls, type Tx } from '@callfront/db'
import { and, desc, eq, gt, isNull } from 'drizzle-orm'
import { recordingStoreFromEnv, type RecordingStore } from './recording-store.ts'

/** How far back, and how many calls per sweep, it looks. */
const WINDOW_MS = 2 * 60 * 60 * 1000
const LIMIT = 50
const SWEEP_EVERY_MS = 60_000

/** Links every recent completed call without a recording whose file is in the store. Returns the linked ids. */
export async function linkOrphanRecordings(tx: Tx, store: RecordingStore, now = new Date()): Promise<string[]> {
  const since = new Date(now.getTime() - WINDOW_MS).toISOString()
  const unlinked = await tx.select({ id: calls.id, workspace_id: calls.workspace_id }).from(calls)
    .where(and(eq(calls.status, 'completed'), isNull(calls.recording_key), gt(calls.ended_at, since)))
    .orderBy(desc(calls.ended_at)).limit(LIMIT)
  const linked: string[] = []
  for (const call of unlinked) {
    const key = recordingKey(call.workspace_id, call.id)
    if (!(await store.exists(key))) continue
    const updated = await tx.update(calls).set({ recording_key: key })
      .where(and(eq(calls.id, call.id), isNull(calls.recording_key))) // not if the agent reported it meanwhile
      .returning({ id: calls.id })
    linked.push(...updated.map(u => u.id))
  }
  return linked
}

/** Runs the sweep every minute in the API process when recordings are on. Never throws. */
export function startOrphanRecordingSweep(tx: Tx, env: Record<string, string | undefined> = process.env) {
  let store: RecordingStore
  try {
    store = recordingStoreFromEnv(env)
  } catch (e) {
    console.warn(`unreported recordings are not linked: ${e instanceof Error ? e.message : e}`)
    return () => {}
  }
  const sweep = () =>
    linkOrphanRecordings(tx, store)
      .then(ids => ids.length && console.log(`linked ${ids.length} unreported recording(s): ${ids.join(', ')}`))
      .catch(e => console.error('recording sweep failed', e))
  const timer = setInterval(sweep, SWEEP_EVERY_MS)
  timer.unref()
  void sweep()
  return () => clearInterval(timer)
}
