// Deletes call recordings older than their workspace keeps them (workspace_settings.recording_retention_days,
// 90 days by default, null keeps them, 0 keeps none: see deleteCallRecording). Runs daily as a pg-boss job (jobs.ts). The call stays; only
// its audio goes, and `recording_key` is cleared so the player disappears in every browser.
import { DEFAULT_RECORDING_RETENTION_DAYS, RECORDINGS_NOT_KEPT } from '@linedesk/actions'
import { calls, type Tx, workspace_settings } from '@linedesk/db'
import { and, eq, isNotNull, lt, sql } from 'drizzle-orm'
import type { RecordingStoreName } from '@linedesk/actions'
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

/** Whether the workspace keeps recordings at all (Settings, Recordings: "Don't keep" is 0 days). */
export async function keepsRecordings(db: Tx, workspaceId: string): Promise<boolean> {
  const [row] = await db.select({ days: workspace_settings.recording_retention_days }).from(workspace_settings)
    .where(eq(workspace_settings.workspace_id, workspaceId))
  return row?.days !== RECORDINGS_NOT_KEPT
}

/**
 * Deletes one call's recording from its store, then clears the key (the player goes in every browser).
 * For a workspace that keeps none, right after the call (the recording.delete job). Throws when the
 * store refuses, so the job is retried; a file that is already gone counts as deleted.
 */
export async function deleteCallRecording(db: Tx, storeFor: StoreFor, callId: string): Promise<boolean> {
  const [call] = await db.select({ key: calls.recording_key, store: calls.recording_store }).from(calls).where(eq(calls.id, callId))
  if (!call?.key) return false
  await (await storeFor(call.store)).delete(call.key)
  await db.update(calls).set({ recording_key: null, recording_store: null }).where(and(eq(calls.id, callId), eq(calls.recording_key, call.key)))
  return true
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
