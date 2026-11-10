import { FetchError, isChangeMessage, isControlMessage, ShapeStream, type Row } from '@electric-sql/client'
import type { ReadSyncAdapter, TableSink } from './adapter.ts'
import { inOrder, type RowChange } from './ordered.ts'

type Cursor = { offset: string; handle: string }
const json = (v: string) => JSON.parse(v) as unknown

/** Restart pauses after a stream gave up: 1 s, 2 s, 4 s … at most 30 s. */
export const restartDelayMs = (attempt: number) => Math.min(30_000, 1000 * 2 ** attempt)

/**
 * The server no longer knows where this client is: an unknown or expired shape handle, an offset
 * out of range, a shape that changed with the schema (Electric recreated or reset, a migration).
 * The only way on is to forget the cursor and load the table again.
 */
export const isStaleCursor = (error: unknown) =>
  error instanceof FetchError && [400, 404, 409, 410].includes(error.status)

type Options = {
  /** How to create a stream; replaced in tests. */
  createStream?: (
    options: ConstructorParameters<typeof ShapeStream<Row<unknown>>>[0],
  ) => Pick<ShapeStream<Row<unknown>>, 'subscribe' | 'lastOffset' | 'shapeHandle'>
  /** How long to wait before restarting; replaced in tests. */
  delayMs?: (attempt: number) => number
}

/**
 * Electric through the API's shape proxy, which adds auth and the workspace filter.
 * It never stops by itself: a stream that gives up (the server was down, a deploy, Electric
 * recreated) is started again with growing pauses, and a cursor the server does not know any more
 * is dropped so the table loads afresh. A fresh load replaces the table once it is complete, so rows
 * deleted meanwhile go too. Pending writes are not touched: they live in the store's outbox.
 */
export const electricAdapter = (
  api: string,
  { createStream = o => new ShapeStream(o), delayMs = restartDelayMs }: Options = {},
): ReadSyncAdapter => ({
  name: 'electric',
  start(table, sink) {
    let stopped = false
    let attempt = 0
    let abort: AbortController | null = null
    let timer: ReturnType<typeof setTimeout> | undefined

    function restartLater(fromScratch: boolean) {
      if (stopped) return
      clearTimeout(timer)
      timer = setTimeout(() => void begin(fromScratch), fromScratch && attempt === 0 ? 0 : delayMs(attempt))
      attempt++
    }

    async function begin(fromScratch: boolean) {
      if (stopped) return
      if (fromScratch) sink.saveCursor(undefined)
      const cursor = fromScratch ? undefined : ((await sink.loadCursor()) as Cursor | undefined)
      if (stopped) return
      const controller = new AbortController()
      abort = controller
      const stream = createStream({
        url: `${api}/v1/shape/${table}`,
        fetchClient: (input, init) => fetch(input, { ...init, credentials: 'include' }),
        signal: controller.signal,
        offset: cursor?.offset as never,
        handle: cursor?.handle,
        parser: { int8: Number, json, jsonb: json },
        // Stop this stream and start a new one: Electric's own retries give up after a while.
        onError: error => {
          if (controller.signal.aborted || stopped) return
          controller.abort()
          restartLater(isStaleCursor(error))
        },
      })
      follow(stream, sink, !cursor, () => {
        attempt = 0
      })
    }

    void begin(false)
    return () => {
      stopped = true
      clearTimeout(timer)
      abort?.abort()
    }
  },
})

/** Applies the stream's messages to the sink. `fresh`: the table loads from the start and is replaced once complete. */
function follow(
  stream: Pick<ShapeStream<Row<unknown>>, 'subscribe' | 'lastOffset' | 'shapeHandle'>,
  sink: TableSink,
  fresh: boolean,
  onUpToDate: () => void,
) {
  let replacing = fresh
  let buffer: Row<unknown>[] = []
  stream.subscribe(messages => {
    const changes: RowChange<Row<unknown>>[] = []
    for (const m of messages) {
      if (isChangeMessage(m)) {
        if (m.headers.operation === 'delete') {
          if (replacing) buffer = buffer.filter(r => r.id !== m.value.id)
          else changes.push({ op: 'remove', id: m.value.id as string })
        } else if (replacing) buffer.push(m.value)
        else changes.push({ op: 'upsert', row: m.value })
      } else if (isControlMessage(m) && m.headers.control === 'must-refetch') {
        replacing = true
        buffer = []
      } else if (isControlMessage(m) && m.headers.control === 'up-to-date') {
        if (replacing) {
          sink.replaceAll(buffer as never)
          replacing = false
          buffer = []
        }
        if (stream.shapeHandle)
          sink.saveCursor({ offset: stream.lastOffset, handle: stream.shapeHandle } satisfies Cursor)
        onUpToDate()
      }
    }
    // In message order: "delete, then insert" for one id (a call restored after a delete) must leave the row.
    for (const run of inOrder(changes)) {
      if (run.op === 'upsert') sink.upsert(run.rows as never)
      else sink.remove(run.ids)
    }
  })
}
