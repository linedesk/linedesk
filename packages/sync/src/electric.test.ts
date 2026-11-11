import 'fake-indexeddb/auto'
import { FetchError } from '@electric-sql/client'
import { describe, expect, it } from 'vitest'
import type { TableSink } from './adapter.ts'
import { electricAdapter, isStaleCursor, shapeUrl } from './electric.ts'
import type { WorkspaceRefusal } from './refusal.ts'
import { openLocalDb } from './idb.ts'
import { forgetCursorsOnNewVersion } from './store.ts'
import { eventually } from './testing.ts'

type Options = { offset?: string; handle?: string; onError?: (error: Error) => unknown }
type Listener = (messages: unknown[]) => void

/** A stand-in for Electric's ShapeStream: the test sends messages and errors. */
function fakeStreams() {
  const streams: { options: Options; send: Listener; fail: (error: Error) => void; handle: string }[] = []
  const createStream = (options: Options) => {
    const stream = {
      options,
      handle: `h${streams.length}`,
      send: (() => {}) as Listener,
      fail: (error: Error) => void options.onError?.(error),
    }
    streams.push(stream)
    return {
      subscribe: (fn: Listener) => {
        stream.send = fn
        return () => {}
      },
      get lastOffset() {
        return `o${streams.length}` as never
      },
      get shapeHandle() {
        return stream.handle
      },
    }
  }
  return { streams, createStream: createStream as never }
}

function memorySink(saved?: unknown) {
  const rows = new Map<string, { id: string }>()
  let cursor = saved
  const refusals: WorkspaceRefusal[] = []
  const sink: TableSink = {
    refuse: r => void refusals.push(r),
    upsert: r => r.forEach(row => rows.set(row.id, row)),
    remove: ids => ids.forEach(id => rows.delete(id)),
    replaceAll: r => {
      rows.clear()
      r.forEach(row => rows.set(row.id, row))
    },
    loadCursor: async () => cursor,
    saveCursor: c => {
      cursor = c
    },
  }
  return { sink, rows, refusals, cursor: () => cursor }
}

const insert = (id: string) => ({ key: id, value: { id }, headers: { operation: 'insert' } })
const upToDate = { headers: { control: 'up-to-date' } }
const stale = (status: number) => new FetchError(status, 'stale', undefined, {}, 'http://x/v1/shape/calls')

describe('electric adapter', () => {
  it('puts the workspace in the shape URL, so each workspace has its own Electric state', () => {
    expect(shapeUrl('', 'calls', 'ws_a')).toBe('/v1/shape/calls?workspace=ws_a')
    expect(shapeUrl('', 'calls', 'ws_b')).not.toBe(shapeUrl('', 'calls', 'ws_a'))
    expect(shapeUrl('', 'calls')).toBe('/v1/shape/calls')
  })

  it('sends the workspace with every shape request', async () => {
    const { streams, createStream } = fakeStreams()
    const store = memorySink()
    const stop = electricAdapter('', { createStream, workspaceId: 'ws_a' }).start('calls', store.sink)
    await eventually(() => expect(streams).toHaveLength(1))
    const options = streams[0]!.options as Options & { url: string; fetchClient: typeof fetch }
    expect(options.url).toBe('/v1/shape/calls?workspace=ws_a')
    const seen: Headers[] = []
    const realFetch = globalThis.fetch
    globalThis.fetch = (async (_: unknown, init?: RequestInit) => {
      seen.push(new Headers(init?.headers))
      return new Response('[]')
    }) as typeof fetch
    try {
      await options.fetchClient('/v1/shape/calls?workspace=ws_a', { headers: { accept: 'application/json' } })
    } finally {
      globalThis.fetch = realFetch
    }
    expect(seen[0]!.get('x-workspace-id')).toBe('ws_a')
    expect(seen[0]!.get('accept')).toBe('application/json')
    stop()
  })

  it('stops a table for good when the server refuses the workspace, and tells the sink', async () => {
    const { streams, createStream } = fakeStreams()
    const store = memorySink()
    const stop = electricAdapter('', { createStream, delayMs: () => 0, workspaceId: 'ws_a' }).start('calls', store.sink)
    await eventually(() => expect(streams).toHaveLength(1))
    const refused = { ok: false, error: 'switched', code: 'workspace_switched', activeWorkspaceId: 'ws_b' }
    streams[0]!.fail(new FetchError(403, undefined, refused, {}, 'http://x/v1/shape/calls'))
    await eventually(() => expect(store.refusals).toEqual([{ code: 'workspace_switched', activeWorkspaceId: 'ws_b' }]))
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(streams).toHaveLength(1) // not started again
    stop()
  })

  it('keeps retrying a 403 that is not a workspace refusal', async () => {
    const { streams, createStream } = fakeStreams()
    const store = memorySink()
    const stop = electricAdapter('', { createStream, delayMs: () => 0 }).start('calls', store.sink)
    await eventually(() => expect(streams).toHaveLength(1))
    streams[0]!.fail(new FetchError(403, undefined, { ok: false, error: 'forbidden' }, {}, 'http://x/v1/shape/calls'))
    await eventually(() => expect(streams).toHaveLength(2))
    expect(store.refusals).toEqual([])
    stop()
  })
  it('drops a cursor the server no longer knows and loads the table again, replacing the old rows', async () => {
    const { streams, createStream } = fakeStreams()
    const store = memorySink({ offset: 'old', handle: 'gone' })
    store.rows.set('deleted-meanwhile', { id: 'deleted-meanwhile' })
    const stop = electricAdapter('', { createStream, delayMs: () => 0 }).start('calls', store.sink)
    await eventually(() => expect(streams).toHaveLength(1))
    expect(streams[0]!.options).toMatchObject({ offset: 'old', handle: 'gone' })

    streams[0]!.fail(stale(409)) // Electric was recreated: the handle is unknown
    await eventually(() => expect(streams).toHaveLength(2))
    expect(streams[1]!.options.offset).toBeUndefined() // from the start
    streams[1]!.send([insert('a'), insert('b'), upToDate])
    expect([...store.rows.keys()]).toEqual(['a', 'b'])
    expect(store.cursor()).toMatchObject({ handle: 'h1' })
    stop()
  })

  it('starts a stream that gave up again with its cursor, after a pause', async () => {
    const { streams, createStream } = fakeStreams()
    const store = memorySink({ offset: 'o5', handle: 'h5' })
    const stop = electricAdapter('', { createStream, delayMs: () => 5 }).start('calls', store.sink)
    await eventually(() => expect(streams).toHaveLength(1))
    streams[0]!.fail(new Error('Failed to fetch')) // the API was down long enough for Electric's own retries to give up
    await eventually(() => expect(streams).toHaveLength(2))
    expect(streams[1]!.options).toMatchObject({ offset: 'o5', handle: 'h5' })
    stop()
  })

  it('tells stale cursors from other errors', () => {
    for (const status of [400, 409]) expect(isStaleCursor(stale(status))).toBe(true)
    expect(isStaleCursor(stale(502))).toBe(false)
    expect(isStaleCursor(new Error('offline'))).toBe(false)
  })
})

describe('a new app version', () => {
  it('forgets the read-sync cursors once, and keeps the outbox', async () => {
    const local = await openLocalDb('version-test')
    await local.write('meta', s => {
      s.put({ handle: 'h' }, 'cursor:calls')
      s.put('v1', 'appVersion')
    })
    await local.write('outbox', s => s.put({ id: 'cmd1' }, 'cmd1'))
    expect(await forgetCursorsOnNewVersion(local, 'v1')).toBe(false)
    expect(await forgetCursorsOnNewVersion(local, 'v2')).toBe(true)
    expect((await local.all('meta')).map(([key]) => key)).toEqual(['appVersion'])
    expect(await local.all('outbox')).toHaveLength(1)
    expect(await forgetCursorsOnNewVersion(local, 'v2')).toBe(false)
    local.close()
  })
})

describe('tables that are not live', () => {
  it('are read up to date without a live request, then again on refresh or after a while', async () => {
    const { streams, createStream } = fakeStreams()
    const adapter = electricAdapter('', { createStream, liveTables: ['calls'], pollMs: 50 })
    const live = memorySink()
    const settings = memorySink()
    const stopLive = adapter.start('calls', live.sink)
    const stop = adapter.start('assistants', settings.sink)
    await eventually(() => expect(streams).toHaveLength(2))
    expect(streams.map(s => (s.options as { subscribe?: boolean }).subscribe)).toEqual([true, false])

    // Up to date: the next read waits; a refresh while it is still running does not start another.
    streams[1]!.send([insert('as1'), upToDate])
    expect(settings.rows.has('as1')).toBe(true)
    adapter.refresh?.()
    await eventually(() => expect(streams).toHaveLength(3))
    expect(streams[2]!.options).toMatchObject({ subscribe: false, handle: 'h1', url: '/v1/shape/assistants' })
    adapter.refresh?.()
    expect(streams).toHaveLength(3)

    // Without a refresh it is read again after pollMs; the live table never is.
    streams[2]!.send([upToDate])
    await eventually(() => expect(streams).toHaveLength(4))
    expect(streams[3]!.options).toMatchObject({ subscribe: false, url: '/v1/shape/assistants' })
    stop()
    stopLive()
  })
})
