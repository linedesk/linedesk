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
}

export interface ReadSyncAdapter {
  name: string
  /** Start streaming one table into the sink. Returns a stop function. */
  start<T extends TableName>(table: T, sink: TableSink<T>): () => void
  /** Check the tables that are not followed live now (after a write of this tab). */
  refresh?(): void
}
