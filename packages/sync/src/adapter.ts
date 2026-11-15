// Reads come from the server through a ReadSyncAdapter. Swapping the sync provider means
// writing another adapter; the store and the UI never see vendor types.
import type { TableName, Tables } from '@linedesk/db/types'
import type { WorkspaceRefusal, WorkspaceState } from './refusal.ts'

export interface TableSink<T extends TableName = TableName> {
  upsert(rows: Tables[T][]): void
  remove(ids: string[]): void
  /** Replace the whole table (after the server asks for a refetch). */
  replaceAll(rows: Tables[T][]): void
  loadCursor(): Promise<unknown>
  saveCursor(cursor: unknown): void
  /** The server refuses this tab's workspace: the adapter has stopped the table and does not retry. */
  refuse(refusal: WorkspaceRefusal): void
  /** What the server said about the workspace with its latest answer (disabled by an instance admin, or active). */
  workspaceState(state: WorkspaceState): void
  /** Whether the latest read request reached the server: false on a network error or a 5xx (the adapter keeps retrying). */
  reachable?(ok: boolean): void
}

/**
 * `fresh`: the whole table again, not only what changed since this device's cursor. Rows are missing locally that the
 * cursor says this device has (the local copy was emptied or lost while the leading tab kept its cursor).
 */
export type RefreshOptions = { fresh?: boolean }

export interface ReadSyncAdapter {
  name: string
  /** Start streaming one table into the sink. Returns a stop function. */
  start<T extends TableName>(table: T, sink: TableSink<T>): () => void
  /**
   * Check the tables that are not followed live now (all, or these): after a write that did not go
   * through the outbox, on return from a redirect, on focus. Resolves once they are read up to date
   * by a read that started after the call. `fresh`: read them from the start and replace what this
   * device has, for rows a tab is missing although its table counts as up to date (see RefreshOptions).
   */
  refresh?(tables?: readonly TableName[], options?: RefreshOptions): Promise<void> | void
}
