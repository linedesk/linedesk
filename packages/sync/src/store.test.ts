import 'fake-indexeddb/auto'
import type { Call } from '@callfront/db/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ReadSyncAdapter, TableSink } from './adapter.ts'
import { createStore } from './store.ts'

const call = (over: Partial<Call> = {}) => ({ id: 'c1', inbox_state: 'open', unread: true, version: 1, ...over }) as Call

function fakeAdapter() {
  const sinks = new Map<string, TableSink>()
  const adapter: ReadSyncAdapter = { name: 'fake', start: (table, sink) => { sinks.set(table, sink as never); return () => {} } }
  return { adapter, calls: () => sinks.get('calls') as TableSink<'calls'> }
}
const respond = (status: number, body: unknown) => new Response(JSON.stringify(body), { status })
const settle = () => new Promise(r => setTimeout(r, 20))
let n = 0
const open = (adapter: ReadSyncAdapter, extra = {}) => createStore({ api: '', dbName: `t${n}`, adapter, retryMs: 5, ...extra })

afterEach(() => { n++; vi.unstubAllGlobals() })

describe('store', () => {
  it('applies an action at once and keeps the server row after the ack', async () => {
    const fetchMock = vi.fn(async () => respond(200, { ok: true, rows: { calls: [call({ inbox_state: 'done', unread: false, version: 5 })] } }))
    vi.stubGlobal('fetch', fetchMock)
    const { adapter, calls } = fakeAdapter()
    const store = await open(adapter)
    calls().upsert([call()])
    const pending = store.run('call.markDone', { callId: 'c1' })
    expect(store.rows('calls')[0]!.inbox_state).toBe('done') // before any network
    await pending; await settle()
    expect(store.getSnapshot().pending).toBe(0)
    expect(store.rows('calls')[0]!.version).toBe(5)
    calls().upsert([call({ version: 2 })]) // a stale sync message must not undo it
    expect(store.rows('calls')[0]!.inbox_state).toBe('done')
    store.stop()
  })

  it('rolls back and reports when the server rejects', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => respond(409, { ok: false, error: 'nope' })))
    const { adapter, calls } = fakeAdapter()
    const onReject = vi.fn()
    const store = await open(adapter, { onReject })
    calls().upsert([call()])
    await store.run('call.markDone', { callId: 'c1' }); await settle()
    expect(store.rows('calls')[0]!.inbox_state).toBe('open')
    expect(onReject).toHaveBeenCalledWith(expect.objectContaining({ action: 'call.markDone', error: 'nope' }))
    store.stop()
  })

  it('keeps commands while offline, across a reload, and replays them in order', async () => {
    const sent: string[] = []
    let offline = true
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (offline) throw new TypeError('offline')
      sent.push(url.split('/').pop()!)
      return respond(200, { ok: true, rows: {} })
    }))
    const first = fakeAdapter()
    const store = await open(first.adapter)
    first.calls().upsert([call()])
    await store.run('call.markDone', { callId: 'c1' })
    await store.run('call.markUnread', { callId: 'c1' }); await settle()
    expect(store.getSnapshot()).toMatchObject({ pending: 2, online: false })
    store.stop()

    const reloaded = await open(fakeAdapter().adapter) // same dbName: n only changes after the test
    expect(reloaded.rows('calls')[0]).toMatchObject({ inbox_state: 'done', unread: true })
    offline = false
    await reloaded.flush(); await settle()
    expect(sent).toEqual(['call.markDone', 'call.markUnread'])
    expect(reloaded.getSnapshot().pending).toBe(0)
    reloaded.stop()
  })

  it('sends a command that was added while another one was still on its way', async () => {
    const sent: string[] = []
    const waiting: (() => void)[] = []
    vi.stubGlobal('fetch', vi.fn((url: string) => new Promise<Response>(resolve => {
      sent.push(url.split('/').pop()!)
      waiting.push(() => resolve(respond(200, { ok: true, rows: {} })))
    })))
    const { adapter, calls } = fakeAdapter()
    const store = await open(adapter)
    calls().upsert([call()])
    await store.run('call.delete', { callId: 'c1' }) // request in flight
    await store.run('call.restore', { callId: 'c1' }) // added meanwhile: must not wait for a later action
    expect(sent).toEqual(['call.delete'])
    waiting.shift()!(); await settle()
    expect(sent).toEqual(['call.delete', 'call.restore'])
    waiting.shift()!(); await settle()
    expect(store.getSnapshot().pending).toBe(0)
    store.stop()
  })

  it('writes nothing after stop, even when a request answers late', async () => {
    let answer: (r: Response) => void = () => {}
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { answer = resolve })))
    const { adapter, calls } = fakeAdapter()
    const store = await open(adapter)
    calls().upsert([call()])
    await store.run('call.markDone', { callId: 'c1' })
    store.stop()
    // vitest fails the run on an unhandled rejection, which a write to the closed database used to cause
    answer(respond(200, { ok: true, rows: { calls: [call({ inbox_state: 'done', version: 9 })] } }))
    calls().upsert([call({ version: 12 })]) // a late sync message
    await settle()
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
