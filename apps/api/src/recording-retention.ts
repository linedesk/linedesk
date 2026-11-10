// Deletes call recordings older than their workspace keeps them (workspace_settings.recording_retention_days,
// 90 days by default, null keeps them). Runs daily as a pg-boss job (jobs.ts). The call stays; only
// its audio goes, and `recording_key` is cleared so the player disappears in every browser.
import { DEFAULT_RECORDING_RETENTION_DAYS } from '@callfront/actions'
import { calls, type Tx, workspace_settings } from '@callfront/db'
import { and, eq, isNotNull, lt, sql } from 'drizzle-orm'
import type { RecordingStoreName } from '@callfront/actions'
import type { RecordingStore } from './recording-store.ts'

/** The store a recording is in, by calls.recording_store (null: recorded before stores were per call). */
export type StoreFor = (name: RecordingStoreName | null) => Promise<RecordingStore> | RecordingStore

/** Per run; a backlog is worked off over the next days instead of in one long run. */
const BATCH = 500

export type CleanupResult = { deleted: number; failed: number }

/** Calls whose recording is past their workspace's retention at `now`. */
function expiredRecordings(db: Tx, now: string, limit: number) {
  // No settings row: the default applies. A row with null: keep forever.
  const days = sql<
    number | null
  >`case when ${workspace_settings.workspace_id} is null then ${DEFAULT_RECORDING_RETENTION_DAYS} else ${workspace_settings.recording_retention_days} end`
  return db
    .select({ id: calls.id, key: calls.recording_key, store: calls.recording_store })
    .from(calls)
    .leftJoin(workspace_settings, eq(workspace_settings.workspace_id, calls.workspace_id))
    .where(
      and(
        isNotNull(calls.recording_key),
        sql`${days} is not null`,
        lt(
          sql`coalesce(${calls.ended_at}, ${calls.started_at})`,
          sql`${now}::timestamptz - make_interval(days => ${days})`,
        ),
      ),
    )
    .limit(limit)
}

/**
 * One call at a time: the file first, then the key, so a failed delete is retried on the next run.
 * Each recording is deleted from the store it is in, not the one new calls go to.
 */
export async function deleteExpiredRecordings(
  db: Tx,
  storeFor: StoreFor,
  now = new Date().toISOString(),
  limit = BATCH,
): Promise<CleanupResult> {
  const result: CleanupResult = { deleted: 0, failed: 0 }
  for (const { id, key, store } of await expiredRecordings(db, now, limit)) {
    try {
      await (await storeFor(store)).delete(key!)
      await db.update(calls).set({ recording_key: null, recording_store: null }).where(eq(calls.id, id))
      result.deleted++
    } catch (e) {
      result.failed++
      console.warn(`could not delete the recording of call ${id}: ${e instanceof Error ? e.message : e}`)
    }
  }
  return result
}
