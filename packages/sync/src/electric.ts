import { isChangeMessage, isControlMessage, ShapeStream, type Row } from '@electric-sql/client'
import type { ReadSyncAdapter } from './adapter.ts'
import { inOrder, type RowChange } from './ordered.ts'

type Cursor = { offset: string; handle: string }
const json = (v: string) => JSON.parse(v) as unknown

/** Electric through the API's shape proxy, which adds auth and the workspace filter. */
export const electricAdapter = (api: string): ReadSyncAdapter => ({
  name: 'electric',
  start(table, sink) {
    const abort = new AbortController()
    void sink.loadCursor().then(saved => {
      const cursor = saved as Cursor | undefined
      const stream = new ShapeStream<Row<unknown>>({
        url: `${api}/v1/shape/${table}`,
        fetchClient: (input, init) => fetch(input, { ...init, credentials: 'include' }),
        signal: abort.signal,
        offset: cursor?.offset as never,
        handle: cursor?.handle,
        parser: { int8: Number, json, jsonb: json },
        onError: () => ({}), // keep retrying while offline
      })
      let refetching = false
      let buffer: Row<unknown>[] = []
      stream.subscribe(messages => {
        const changes: RowChange<Row<unknown>>[] = []
        for (const m of messages) {
          if (isChangeMessage(m)) {
            if (m.headers.operation === 'delete') changes.push({ op: 'remove', id: m.value.id as string })
            else if (refetching) buffer.push(m.value)
            else changes.push({ op: 'upsert', row: m.value })
          } else if (isControlMessage(m) && m.headers.control === 'must-refetch') {
            refetching = true
            buffer = []
          } else if (isControlMessage(m) && m.headers.control === 'up-to-date') {
            if (refetching) { sink.replaceAll(buffer as never); refetching = false }
            if (stream.shapeHandle) sink.saveCursor({ offset: stream.lastOffset, handle: stream.shapeHandle } satisfies Cursor)
          }
        }
        // In message order: "delete, then insert" for one id (a call restored after a delete) must leave the row.
        for (const run of inOrder(changes)) {
          if (run.op === 'upsert') sink.upsert(run.rows as never)
          else sink.remove(run.ids)
        }
      })
    })
    return () => abort.abort()
  },
})
