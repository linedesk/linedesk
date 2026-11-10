// Reads come from the server through a ReadSyncAdapter. Swapping the sync provider means
// writing another adapter; the store and the UI never see vendor types.
import type { TableName, Tables } from '@callfront/db/types'

export interface TableSink<T extends TableName = TableName> {
  upsert(rows: Tables[T][]): void
  remove(ids: string[]): void
  /** Replace the whole table (after the server asks for a refetch). */
  replaceAll(rows: Tables[T][]): void
  loadCursor(): Promise<unknown>
  saveCursor(cursor: unknown): void
}

export interface ReadSyncAdapter {
  name: string
  /** Start streaming one table into the sink. Returns a stop function. */
  start<T extends TableName>(table: T, sink: TableSink<T>): () => void
}
