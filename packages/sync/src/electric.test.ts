import 'fake-indexeddb/auto'
import { FetchError } from '@electric-sql/client'
import { describe, expect, it } from 'vitest'
import type { TableSink } from './adapter.ts'
import { electricAdapter, isStaleCursor } from './electric.ts'
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
  const sink: TableSink = {
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
  return { sink, rows, cursor: () => cursor }
}

const insert = (id: string) => ({ key: id, value: { id }, headers: { operation: 'insert' } })
const upToDate = { headers: { control: 'up-to-date' } }
const stale = (status: number) => new FetchError(status, 'stale', undefined, {}, 'http://x/v1/shape/calls')

describe('electric adapter', () => {
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
