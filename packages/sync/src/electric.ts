import { FetchError, isChangeMessage, isControlMessage, ShapeStream, type Row } from '@electric-sql/client'
import type { TableName } from '@linedesk/db/types'
import type { ReadSyncAdapter, TableSink } from './adapter.ts'
import { inOrder, type RowChange } from './ordered.ts'
import { type PageScope, refusalOf, workspaceRequestHeaders, workspaceStateOf } from './refusal.ts'

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
  /**
   * The tables followed live (a long-polling request each). The others are read up to date, then
   * checked again every `pollMs`, when the window gets focus, and on `refresh()`. A browser opens at
   * most six connections per host over HTTP/1.1: a live request per table would leave writes waiting.
   * Default: every table is live.
   */
  liveTables?: readonly TableName[]
  /** How often a table that is not live is checked again. */
  pollMs?: number
  /** The workspace this tab reads: sent with every shape request, which the server checks against the session. */
  workspaceId?: string
  /** The account the page was opened for, sent too: the server refuses it once someone else signed in. */
  account?: string
}

/** Shape requests yield to everything else the page asks for (writes, admin actions). */
const LOW: RequestInit = { priority: 'low' } as RequestInit

/** A table's shape URL. With the workspace in it, every workspace's shape has its own URL, so Electric's per-URL state (expired handles) never mixes workspaces. */
export const shapeUrl = (api: string, table: TableName, workspaceId?: string) =>
  `${api}/v1/shape/${table}${workspaceId ? `?workspace=${encodeURIComponent(workspaceId)}` : ''}`

/** The request's headers with the tab's workspace and the page's protocol added. */
function withWorkspace(headers: HeadersInit | undefined, scope: PageScope): Headers {
  const merged = new Headers(headers)
  for (const [name, value] of Object.entries(workspaceRequestHeaders(scope))) merged.set(name, value)
  return merged
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
  { createStream = o => new ShapeStream(o), delayMs = restartDelayMs, liveTables, pollMs = 60_000, workspaceId, account }: Options = {},
): ReadSyncAdapter => {
  /** Re-checks of the tables that are not live, by table. */
  const pokes = new Set<() => void>()
  const pokeAll = () => {
    for (const poke of pokes) poke()
  }
  return {
    name: 'electric',
    refresh: pokeAll,
    start(table, sink) {
      const live = !liveTables || liveTables.includes(table)
      let stopped = false
      /** A one-off read of a table that is not live is running. */
      let reading = false
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
        reading = !live
        const stream = createStream({
          url: shapeUrl(api, table, workspaceId),
          fetchClient: async (input, init) => {
            const headers = withWorkspace(init?.headers, { workspaceId, account })
            const res = await fetch(input, { ...init, ...LOW, credentials: 'include', headers })
            // Every answer says whether the workspace is disabled: a live table notices within a long-poll.
            const state = workspaceStateOf(res.headers)
            if (state && !stopped) sink.workspaceState(state)
            return res
          },
          signal: controller.signal,
          subscribe: live,
          offset: cursor?.offset as never,
          handle: cursor?.handle,
          parser: { int8: Number, json, jsonb: json },
          // Stop this stream and start a new one: Electric's own retries give up after a while.
          onError: error => {
            if (controller.signal.aborted || stopped) return
            controller.abort()
            // Signed out, or not this tab's workspace any more: retrying cannot help, the store stops and says so.
            const refusal = error instanceof FetchError ? refusalOf(error.status, error.json) : null
            if (refusal) {
              stopped = true
              return sink.refuse(refusal)
            }
            restartLater(isStaleCursor(error))
          },
        })
        follow(stream, sink, !cursor, () => {
          attempt = 0
          if (live) return
          // Read up to date: check again later (or sooner, on focus or after a write).
          reading = false
          clearTimeout(timer)
          timer = setTimeout(poke, pollMs)
        })
      }
      /** A table that is not live: read it again now, unless a read is already running. */
      function poke() {
        if (stopped || reading) return
        clearTimeout(timer)
        void begin(false)
      }

      if (!live) {
        pokes.add(poke)
        if (pokes.size === 1) globalThis.addEventListener?.('focus', pokeAll)
      }
      void begin(false)
      return () => {
        stopped = true
        clearTimeout(timer)
        abort?.abort()
        pokes.delete(poke)
        if (!live && pokes.size === 0) globalThis.removeEventListener?.('focus', pokeAll)
      }
    },
  }
}

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
