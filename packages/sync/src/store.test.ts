import 'fake-indexeddb/auto'
import { type Call, tableNames } from '@linedesk/db/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ReadSyncAdapter, TableSink } from './adapter.ts'
import { createStore } from './store.ts'
import { eventually, quietFor } from './testing.ts'

const call = (over: Partial<Call> = {}) =>
  ({ id: 'c1', inbox_state: 'open', unread: true, version: 1, ...over }) as Call

function fakeAdapter() {
  const sinks = new Map<string, TableSink>()
  const adapter: ReadSyncAdapter = {
    name: 'fake',
    start: (table, sink) => {
      sinks.set(table, sink as never)
      return () => {}
    },
  }
  return { adapter, calls: () => sinks.get('calls') as TableSink<'calls'> }
}
const respond = (status: number, body: unknown) => new Response(JSON.stringify(body), { status })
let n = 0
const open = (adapter: ReadSyncAdapter, extra = {}) =>
  createStore({ api: '', dbName: `t${n}`, adapter, retryMs: 5, ...extra })

afterEach(() => {
  n++
  vi.unstubAllGlobals()
})

describe('store', () => {
  it('applies an action at once and keeps the server row after the ack', async () => {
    const fetchMock = vi.fn(async () =>
      respond(200, { ok: true, rows: { calls: [call({ inbox_state: 'done', unread: false, version: 5 })] } }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const { adapter, calls } = fakeAdapter()
    const store = await open(adapter)
    calls().upsert([call()])
    const pending = store.run('call.markDone', { callId: 'c1' })
    expect(store.rows('calls')[0]!.inbox_state).toBe('done') // before any network
    await pending
    await eventually(() => {
      expect(store.getSnapshot().pending).toBe(0)
      expect(store.rows('calls')[0]!.version).toBe(5)
    })
    calls().upsert([call({ version: 2 })]) // a stale sync message must not undo it
    expect(store.rows('calls')[0]!.inbox_state).toBe('done')
    store.stop()
  })

  it('drops the rows an action deleted as soon as the server answers, without waiting for read sync', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => respond(200, { ok: true, rows: {}, deleted: { calls: ['c1'] } })))
    const { adapter, calls } = fakeAdapter()
    const refresh = vi.fn()
    const store = await open({ ...adapter, refresh })
    calls().upsert([call(), call({ id: 'c2' })])
    await store.run('call.markDone', { callId: 'c1' })
    await eventually(() => expect(store.rows('calls').map(c => c.id)).toEqual(['c2']))
    expect(refresh).toHaveBeenCalled()
    store.stop()
  })

  it('shows the rows of an action that ran outside the outbox at once, and asks the server for the rest', async () => {
    const { adapter, calls } = fakeAdapter()
    const refresh = vi.fn()
    const store = await open({ ...adapter, refresh })
    calls().upsert([call({ id: 'old' })])
    store.applyResult({ rows: { calls: [call({ id: 'new', version: 3 })] }, deleted: { calls: ['old'] } })
    expect(store.rows('calls').map(c => c.id)).toEqual(['new'])
    expect(refresh).toHaveBeenCalledOnce()
    store.stop()
  })

  it('knows when a table has caught up with the server, also after a reload', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => respond(200, { ok: true, rows: {} })),
    )
    const first = fakeAdapter()
    const store = await open(first.adapter)
    expect(store.getSnapshot().synced.has('calls')).toBe(false) // empty means "not loaded yet"
    first.calls().saveCursor({ offset: '0_0', handle: 'h' }) // the adapter is up to date
    expect(store.getSnapshot().synced.has('calls')).toBe(true)
    store.stop()
    const again = await open(fakeAdapter().adapter)
    expect(again.getSnapshot().synced.has('calls')).toBe(true) // the cursor on disk says it was loaded before
    expect(again.getSnapshot().synced.has('contacts')).toBe(false)
    again.stop()
  })

  it('rolls back and reports when the server rejects', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => respond(409, { ok: false, error: 'nope' })),
    )
    const { adapter, calls } = fakeAdapter()
    const onReject = vi.fn()
    const store = await open(adapter, { onReject })
    calls().upsert([call()])
    await store.run('call.markDone', { callId: 'c1' })
    await eventually(() => expect(store.rows('calls')[0]!.inbox_state).toBe('open'))
    expect(onReject).toHaveBeenCalledWith(expect.objectContaining({ action: 'call.markDone', error: 'nope' }))
    store.stop()
  })

  it('keeps commands while offline, across a reload, and replays them in order', async () => {
    const sent: string[] = []
    let offline = true
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (offline) throw new TypeError('offline')
        sent.push(url.split('/').pop()!)
        return respond(200, { ok: true, rows: {} })
      }),
    )
    const first = fakeAdapter()
    const store = await open(first.adapter)
    first.calls().upsert([call()])
    await store.run('call.markDone', { callId: 'c1' })
    await store.run('call.markUnread', { callId: 'c1' })
    await eventually(() => expect(store.getSnapshot()).toMatchObject({ pending: 2, online: false }))
    store.stop()

    const reloaded = await open(fakeAdapter().adapter) // same dbName: n only changes after the test
    expect(reloaded.rows('calls')[0]).toMatchObject({ inbox_state: 'done', unread: true })
    offline = false
    await reloaded.flush()
    await eventually(() => {
      expect(sent).toEqual(['call.markDone', 'call.markUnread'])
      expect(reloaded.getSnapshot().pending).toBe(0)
    })
    reloaded.stop()
  })

  it('sends a command that was added while another one was still on its way', async () => {
    const sent: string[] = []
    const waiting: (() => void)[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (url: string) =>
          new Promise<Response>(resolve => {
            sent.push(url.split('/').pop()!)
            waiting.push(() => resolve(respond(200, { ok: true, rows: {} })))
          }),
      ),
    )
    const { adapter, calls } = fakeAdapter()
    const store = await open(adapter)
    calls().upsert([call()])
    await store.run('call.delete', { callId: 'c1' }) // request in flight
    await store.run('call.restore', { callId: 'c1' }) // added meanwhile: must not wait for a later action
    expect(sent).toEqual(['call.delete'])
    waiting.shift()!()
    await eventually(() => expect(sent).toEqual(['call.delete', 'call.restore']))
    waiting.shift()!()
    await eventually(() => expect(store.getSnapshot().pending).toBe(0))
    store.stop()
  })

  it('keeps the order of commands issued in the same millisecond', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-11-10T12:00:00.000Z'))
    const sent: string[] = []
    let offline = true
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (offline) throw new TypeError('offline')
        sent.push(url.split('/').pop()!)
        return respond(200, { ok: true, rows: {} })
      }),
    )
    const { adapter, calls } = fakeAdapter()
    const store = await open(adapter)
    calls().upsert([call()])
    const names = ['call.markDone', 'call.markUnread', 'call.markRead', 'call.markNotDone', 'call.markUnread']
    for (const name of names) await store.run(name, { callId: 'c1' })
    expect(store.rows('calls')[0]).toMatchObject({ inbox_state: 'open', unread: true })
    store.stop()
    const reloaded = await open(fakeAdapter().adapter)
    expect(reloaded.rows('calls')[0]).toMatchObject({ inbox_state: 'open', unread: true }) // same order after a reload
    offline = false
    await reloaded.flush()
    await eventually(() => expect(sent).toEqual(names))
    reloaded.stop()
    vi.restoreAllMocks()
  })

  it('writes nothing after stop, even when a request answers late', async () => {
    let answer: (r: Response) => void = () => {}
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise<Response>(resolve => {
            answer = resolve
          }),
      ),
    )
    const { adapter, calls } = fakeAdapter()
    const store = await open(adapter)
    calls().upsert([call()])
    await store.run('call.markDone', { callId: 'c1' })
    store.stop()
    // vitest fails the run on an unhandled rejection, which a write to the closed database used to cause
    answer(respond(200, { ok: true, rows: { calls: [call({ inbox_state: 'done', version: 9 })] } }))
    calls().upsert([call({ version: 12 })]) // a late sync message
    await quietFor()
    const reopened = await open(fakeAdapter().adapter)
    expect(reopened.getSnapshot().pending).toBe(1) // the command is still there to replay
    expect(reopened.rows('calls')[0]!.version).toBe(1)
    reopened.stop()
  })

  it('closes when another tab deletes the database, so that delete and later opens do not hang', async () => {
    const { adapter } = fakeAdapter()
    const onLocalDbLost = vi.fn()
    await open(adapter, { onLocalDbLost })
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.deleteDatabase(`t${n}`)
      req.onsuccess = () => resolve()
      req.onerror = () => reject(req.error)
      req.onblocked = () => reject(new Error('delete was blocked by the open store'))
    })
    expect(onLocalDbLost).toHaveBeenCalledOnce()
    const again = await open(fakeAdapter().adapter) // opens at once, empty
    expect(again.rows('calls')).toEqual([])
    again.stop()
  })
})

describe('local database', () => {
  it('opens a database a newer build already upgraded (older build after a rollback), keeping its rows', async () => {
    const name = `newer-${n}`
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.open(name, 99)
      req.onupgradeneeded = () => {
        for (const s of [...tableNames, 'outbox', 'meta', 'a_table_from_the_future']) req.result.createObjectStore(s)
      }
      req.onsuccess = () => {
        const tx = req.result.transaction('calls', 'readwrite')
        tx.objectStore('calls').put(call({ id: 'kept' }), 'kept')
        tx.oncomplete = () => {
          req.result.close()
          resolve()
        }
      }
      req.onerror = () => reject(req.error)
    })
    const store = await open(fakeAdapter().adapter, { dbName: name })
    expect(store.rows('calls').map(c => c.id)).toEqual(['kept'])
    store.stop()
  })
})
