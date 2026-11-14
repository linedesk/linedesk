import 'fake-indexeddb/auto'
import { CLIENT_PROTOCOL } from '@linedesk/actions'
import { type Call, tableNames } from '@linedesk/db/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ReadSyncAdapter, TableSink } from './adapter.ts'
import { openLocalDb, resetLocalCache } from './idb.ts'
import { createStore, tabGroupName } from './store.ts'
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
  it('says read sync is down only after its requests fail for a while, and clears it on the next answer', async () => {
    const { adapter, calls } = fakeAdapter()
    const store = await open(adapter, { readSyncDownMs: 20 })
    calls().reachable?.(false)
    calls().reachable?.(false)
    expect(store.getSnapshot().readSyncDown).toBe(false)
    await eventually(() => expect(store.getSnapshot().readSyncDown).toBe(true))
    calls().reachable?.(true)
    expect(store.getSnapshot().readSyncDown).toBe(false)
    calls().reachable?.(false)
    calls().reachable?.(true) // a blip shorter than the wait says nothing
    await quietFor(40)
    expect(store.getSnapshot().readSyncDown).toBe(false)
    store.stop()
  })

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

  it('keeps the Map and rows of a table nothing changed, so what reads only that table does not render again', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise(() => {})),
    ) // the command stays pending
    const { adapter, calls } = fakeAdapter()
    const store = await open(adapter)
    calls().upsert([call(), call({ id: 'c2' })])
    const first = store.getSnapshot()
    void store.run('call.markDone', { callId: 'c1' })
    const patched = store.getSnapshot()
    expect(patched.tables.calls).not.toBe(first.tables.calls)
    expect(patched.tables.calls.get('c2')).toBe(first.tables.calls.get('c2'))
    expect(patched.tables.contacts).toBe(first.tables.contacts)
    calls().upsert([call({ id: 'c2' })]) // the same row again: nothing changed
    expect(store.getSnapshot().tables.calls).toBe(patched.tables.calls) // the pending patch too keeps its row
    calls().upsert([call({ id: 'c2', unread: false, version: 2 })])
    expect(store.getSnapshot().tables.calls).not.toBe(patched.tables.calls)
    store.stop()
  })

  it('sends its workspace with every action', async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => respond(200, { ok: true, rows: {} }))
    vi.stubGlobal('fetch', fetchMock)
    const store = await open(fakeAdapter().adapter, { workspaceId: 'ws_a' })
    await store.run('call.markDone', { callId: 'c1' })
    await eventually(() => expect(store.getSnapshot().pending).toBe(0))
    const sent = new Headers(fetchMock.mock.calls[0]![1].headers)
    expect(sent.get('x-workspace-id')).toBe('ws_a')
    expect(sent.get('x-linedesk-client')).toBe(String(CLIENT_PROTOCOL))
    store.stop()
  })

  it('sends the account the page is for, and a database opened for another account starts empty', async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => respond(503, {}))
    vi.stubGlobal('fetch', fetchMock)
    const dbName = `owned${n}`
    const first = fakeAdapter()
    const a = await open(first.adapter, { dbName, workspaceId: 'ws_x', account: 'user_a' })
    first.calls().upsert([call()])
    await a.run('call.markDone', { callId: 'c1' }) // unsent (the server is down)
    await eventually(() => expect(fetchMock).toHaveBeenCalled())
    expect(new Headers(fetchMock.mock.calls[0]![1].headers).get('x-linedesk-account')).toBe('user_a')
    a.stop()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => respond(200, { ok: true, rows: {} })),
    )
    const sameAccount = await open(fakeAdapter().adapter, { dbName, workspaceId: 'ws_x', account: 'user_a' })
    expect(sameAccount.getSnapshot()).toMatchObject({ pending: 1 }) // still theirs
    sameAccount.stop()
    const other = await open(fakeAdapter().adapter, { dbName, workspaceId: 'ws_x', account: 'user_b' })
    expect(other.getSnapshot().pending).toBe(0) // never sent as user_b
    expect(other.rows('calls')).toEqual([]) // nor shown
    other.stop()
  })

  it('a database from before the account marker keeps its rows but not its unsent changes', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => respond(503, {})),
    )
    const dbName = `unmarked${n}`
    const first = fakeAdapter()
    const before = await open(first.adapter, { dbName }) // an older build: no account
    first.calls().upsert([call()])
    await before.run('call.markDone', { callId: 'c1' })
    before.stop()
    const claimed = await open(fakeAdapter().adapter, { dbName, account: 'user_b' })
    expect(claimed.getSnapshot().pending).toBe(0) // whose change it was is unknown: never sent as user_b
    expect(claimed.rows('calls').map(c => c.id)).toEqual(['c1'])
    claimed.stop()
  })

  it("each account has its own tab group, so one account's tab never follows another's leader", () => {
    expect(tabGroupName('linedesk-ws_x', 'user_a')).not.toBe(tabGroupName('linedesk-ws_x', 'user_b'))
    expect(tabGroupName('linedesk-ws_x', 'user_a')).toBe('linedesk-tabs:linedesk-ws_x:user_a')
  })

  it('after a refusal, read sync still on its way writes nothing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => respond(200, { ok: true, rows: {} })),
    )
    const { adapter, calls } = fakeAdapter()
    const store = await open(adapter, { workspaceId: 'ws_a' })
    calls().refuse({ code: 'account_switched' })
    calls().upsert([call()])
    expect(store.rows('calls')).toEqual([])
    store.stop()
  })

  it('stops sending and reading when the server refuses the workspace, keeping the change queued', async () => {
    const refused = { ok: false, error: 'switched', code: 'workspace_switched', activeWorkspaceId: 'ws_b' }
    const fetchMock = vi.fn(async () => respond(403, refused))
    vi.stubGlobal('fetch', fetchMock)
    const stopped = vi.fn()
    const adapter: ReadSyncAdapter = { name: 'fake', start: () => stopped }
    const onReject = vi.fn()
    const store = await open(adapter, { workspaceId: 'ws_a', onReject })
    await store.run('call.markDone', { callId: 'c1' })
    await eventually(() =>
      expect(store.getSnapshot().refused).toEqual({ code: 'workspace_switched', activeWorkspaceId: 'ws_b' }),
    )
    expect(stopped).toHaveBeenCalledTimes(tableNames.length) // read sync stopped
    expect(store.getSnapshot().pending).toBe(1) // not rolled back, not rejected
    expect(onReject).not.toHaveBeenCalled()
    await quietFor(30)
    expect(fetchMock).toHaveBeenCalledOnce() // and not retried
    await store.run('call.markDone', { callId: 'c2' })
    await quietFor(30)
    expect(fetchMock).toHaveBeenCalledOnce()
    store.stop()
  })

  it('a 401 that is not the API’s own (a proxy in front) rolls nothing back: the change waits and is sent later', async () => {
    let proxyDown = true
    const fetchMock = vi.fn(async () =>
      proxyDown ? respond(401, { error: 'Unauthorized' }) : respond(200, { ok: true, rows: {} }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const onReject = vi.fn()
    const store = await open(fakeAdapter().adapter, { workspaceId: 'ws_a', onReject })
    await store.run('call.markDone', { callId: 'c1' })
    await eventually(() => expect(fetchMock).toHaveBeenCalled())
    expect(store.getSnapshot()).toMatchObject({ refused: null, discarded: 0, pending: 1 }) // kept, not rejected
    proxyDown = false
    await eventually(() => expect(store.getSnapshot().pending).toBe(0)) // retried and sent
    expect(fetchMock.mock.results.length).toBeGreaterThan(1)
    expect(onReject).not.toHaveBeenCalled()
    store.stop()
  })

  it('signed out (401): stops at once, rolls the change back and says so, instead of retrying forever', async () => {
    const fetchMock = vi.fn(async () =>
      respond(401, { ok: false, error: 'not signed in or no workspace', code: 'signed_out' }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const { adapter, calls } = fakeAdapter()
    const onReject = vi.fn()
    const store = await open(adapter, { workspaceId: 'ws_a', onReject })
    calls().upsert([call()])
    await store.run('call.markDone', { callId: 'c1' })
    expect(store.rows('calls')[0]!.inbox_state).toBe('done') // optimistic
    await eventually(() => expect(store.getSnapshot().refused).toEqual({ code: 'signed_out' }))
    expect(store.rows('calls')[0]!.inbox_state).toBe('open') // rolled back
    expect(store.getSnapshot()).toMatchObject({ pending: 0, discarded: 1 })
    await quietFor(30)
    expect(fetchMock).toHaveBeenCalledOnce()
    store.stop()
    const reopened = await open(fakeAdapter().adapter, { dbName: `t${n}` })
    expect(reopened.getSnapshot().pending).toBe(0) // gone from the disk too
    reopened.stop()
  })

  it('after signing out, a new change is not even queued', async () => {
    const fetchMock = vi.fn(async () => respond(200, { ok: true, rows: {} }))
    vi.stubGlobal('fetch', fetchMock)
    const { adapter, calls } = fakeAdapter()
    const store = await open(adapter)
    calls().refuse({ code: 'signed_out' })
    await store.run('call.markDone', { callId: 'c1' })
    expect(store.getSnapshot()).toMatchObject({ pending: 0, discarded: 1 })
    await quietFor(30)
    expect(fetchMock).not.toHaveBeenCalled()
    store.stop()
  })

  it('lost access (403 workspace_access_lost): rolled back as well', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => respond(403, { ok: false, error: 'no access', code: 'workspace_access_lost' })),
    )
    const { adapter, calls } = fakeAdapter()
    const store = await open(adapter, { workspaceId: 'ws_a' })
    calls().upsert([call()])
    await store.run('call.markDone', { callId: 'c1' })
    await eventually(() => expect(store.getSnapshot().refused).toEqual({ code: 'workspace_access_lost' }))
    expect(store.rows('calls')[0]!.inbox_state).toBe('open')
    expect(store.getSnapshot()).toMatchObject({ pending: 0, discarded: 1 })
    store.stop()
  })

  it('knows whether the workspace is disabled from every answer, and when it is enabled again', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ ok: true, rows: {} }), { headers: { 'x-workspace-state': 'disabled' } }),
      ),
    )
    const { adapter, calls } = fakeAdapter()
    const store = await open(adapter, { workspaceId: 'ws_a' })
    expect(store.getSnapshot().workspaceState).toBeNull()
    await store.run('call.markRead', { callId: 'c1' })
    await eventually(() => expect(store.getSnapshot().workspaceState).toBe('disabled'))
    calls().workspaceState('active') // read sync heard it
    expect(store.getSnapshot().workspaceState).toBe('active')
    store.stop()
  })

  it('a refusal from read sync stops the outbox too', async () => {
    const fetchMock = vi.fn(async () => respond(200, { ok: true, rows: {} }))
    vi.stubGlobal('fetch', fetchMock)
    const { adapter, calls } = fakeAdapter()
    const store = await open(adapter, { workspaceId: 'ws_a' })
    calls().refuse({ code: 'workspace_access_lost' })
    expect(store.getSnapshot().refused).toEqual({ code: 'workspace_access_lost' })
    await store.run('call.markDone', { callId: 'c1' })
    await quietFor(30)
    expect(fetchMock).not.toHaveBeenCalled()
    store.stop()
  })

  it('a 403 that is not a workspace refusal still rejects the command', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => respond(403, { ok: false, error: 'forbidden: settings:write' })),
    )
    const onReject = vi.fn()
    const store = await open(fakeAdapter().adapter, { onReject })
    await store.run('call.markDone', { callId: 'c1' })
    await eventually(() =>
      expect(onReject).toHaveBeenCalledWith(expect.objectContaining({ error: 'forbidden: settings:write' })),
    )
    expect(store.getSnapshot().refused).toBeNull()
    store.stop()
  })

  it('drops the rows an action deleted as soon as the server answers, without waiting for read sync', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => respond(200, { ok: true, rows: {}, deleted: { calls: ['c1'] } })),
    )
    const { adapter, calls } = fakeAdapter()
    const refresh = vi.fn()
    const store = await open({ ...adapter, refresh })
    calls().upsert([call(), call({ id: 'c2' })])
    await store.run('call.markDone', { callId: 'c1' })
    await eventually(() => expect(store.rows('calls').map(c => c.id)).toEqual(['c2']))
    // The refresh follows once the command is settled (outbox write), a moment after the rows are gone.
    await eventually(() => expect(refresh).toHaveBeenCalled())
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

  it('reads the polled tables again on a click or key press once they are older than the activity interval', async () => {
    const handlers = new Map<string, () => void>()
    vi.stubGlobal('addEventListener', (type: string, handler: () => void) => handlers.set(type, handler))
    vi.stubGlobal('removeEventListener', (type: string) => handlers.delete(type))
    const refresh = vi.fn(async () => {})
    const store = await open({ ...fakeAdapter().adapter, refresh }, { activityRefreshMs: 40 })
    await eventually(() => expect(handlers.has('pointerdown')).toBe(true))
    refresh.mockClear()
    handlers.get('pointerdown')!() // just started: the first reads are recent enough
    expect(refresh).not.toHaveBeenCalled()
    await new Promise(resolve => setTimeout(resolve, 50))
    handlers.get('keydown')!()
    await eventually(() => expect(refresh).toHaveBeenCalledOnce())
    handlers.get('pointerdown')!() // read a moment ago: not again
    expect(refresh).toHaveBeenCalledOnce()
    store.stop()
    expect(handlers.has('pointerdown')).toBe(false)
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

/** A database an older build created: every store but `missing`, one call row and one unsent command. */
const olderDb = (name: string, version: number, missing: readonly string[]) =>
  new Promise<void>((resolve, reject) => {
    const req = indexedDB.open(name, version)
    req.onupgradeneeded = () => {
      for (const s of [...tableNames, 'outbox', 'meta']) if (!missing.includes(s)) req.result.createObjectStore(s)
    }
    req.onsuccess = () => {
      const tx = req.result.transaction(['calls', 'outbox'], 'readwrite')
      tx.objectStore('calls').put(call({ id: 'kept' }), 'kept')
      tx.objectStore('outbox').put({ id: 'cmd' }, 'cmd')
      tx.oncomplete = () => {
        req.result.close()
        resolve()
      }
    }
    req.onerror = () => reject(req.error)
  })

describe('local database', () => {
  it('adds the store of every synced table an older build did not have, keeping its rows', async () => {
    const name = `older-${n}`
    const newest = tableNames.slice(-2) // whatever was added last: no version number to remember
    await olderDb(name, 4, newest)
    const local = await openLocalDb(name)
    for (const table of newest) expect(await local.all(table)).toEqual([])
    expect((await local.all('calls')).map(([key]) => key)).toEqual(['kept'])
    local.close()
  })

  it('adds a missing store to a database another build left at a higher version', async () => {
    const name = `branch-${n}`
    await olderDb(name, 42, ['knowledge_questions'])
    const local = await openLocalDb(name)
    expect(await local.all('knowledge_questions')).toEqual([])
    local.close()
  })

  it('resetting the local cache empties the synced rows and keeps unsent commands', async () => {
    const name = `reset-${n}`
    await olderDb(name, 4, [])
    await resetLocalCache(name)
    const local = await openLocalDb(name)
    expect(await local.all('calls')).toEqual([])
    expect((await local.all('outbox')).map(([key]) => key)).toEqual(['cmd'])
    local.close()
  })

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

describe('the first screen first', () => {
  /** A fake adapter that records which tables it was asked to read, in order. */
  function recordingAdapter() {
    const started: string[] = []
    const sinks = new Map<string, TableSink>()
    const adapter: ReadSyncAdapter = {
      name: 'fake',
      start: (table, sink) => {
        started.push(table)
        sinks.set(table, sink as never)
        return () => {}
      },
    }
    return { adapter, started, sink: (t: string) => sinks.get(t)! }
  }
  const first = ['calls', 'contacts'] as const

  it('reads the first tables, and the others once those are up to date', async () => {
    const { adapter, started, sink } = recordingAdapter()
    const store = await open(adapter, { firstTables: first })
    await eventually(() => expect(started).toEqual([...first]))
    sink('calls').saveCursor({ offset: '1', handle: 'h' })
    await quietFor()
    expect(started).toEqual([...first]) // contacts is not up to date yet
    sink('contacts').saveCursor({ offset: '1', handle: 'h' })
    await eventually(() => expect(new Set(started)).toEqual(new Set(tableNames)))
    expect(started).toHaveLength(tableNames.length)
    store.stop()
  })

  it('reads them all at once on a device that has the first tables already', async () => {
    const local = await openLocalDb(`t${n}`)
    await local.write('meta', s => first.forEach(t => s.put({ offset: '1', handle: 'h' }, `cursor:${t}`)))
    local.close()
    const { adapter, started } = recordingAdapter()
    const store = await open(adapter, { firstTables: first })
    await eventually(() => expect(started).toHaveLength(tableNames.length))
    expect(started.slice(0, first.length)).toEqual([...first])
    store.stop()
  })

  it('does not let a first table that never gets up to date hold the others back', async () => {
    const { adapter, started } = recordingAdapter()
    const store = await open(adapter, { firstTables: first, firstTablesWaitMs: 30 })
    await eventually(() => expect(started).toHaveLength(tableNames.length))
    store.stop()
  })
})
