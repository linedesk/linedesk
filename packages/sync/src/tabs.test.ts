import 'fake-indexeddb/auto'
import type { Call } from '@linedesk/db/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ReadSyncAdapter, TableSink } from './adapter.ts'
import { createStore } from './store.ts'
import { memoryTabHub } from './tabs.ts'
import { eventually, quietFor } from './testing.ts'

const call = (over: Partial<Call> = {}) => ({ id: 'c1', inbox_state: 'open', unread: true, deleted_at: null, version: 1, ...over }) as Call
const respond = (status: number, body: unknown) => new Response(JSON.stringify(body), { status })
let n = 0
afterEach(() => { n++; vi.unstubAllGlobals() })

/** Two tabs of one browser: one database, one hub. Each tab has its own read-sync adapter. */
function browser() {
  const hub = memoryTabHub()
  function tab(extra: { refresh?: ReadSyncAdapter['refresh'] } & Record<string, unknown> = {}) {
    const sinks = new Map<string, TableSink>()
    let started = 0
    let syncing = 0
    const adapter: ReadSyncAdapter = { name: 'fake', start: (table, sink) => { started++; syncing++; sinks.set(table, sink as never); return () => { syncing-- } }, refresh: extra.refresh }
    const link = hub.link()
    const store = createStore({ api: '', dbName: `tabs${n}`, adapter, retryMs: 5, tabs: link, ...extra })
    return { store, link, sink: (table: string) => sinks.get(table)!, calls: () => sinks.get('calls') as TableSink<'calls'>, syncStarted: () => started > 0, syncing: () => syncing > 0 }
  }
  return { tab }
}

describe('two tabs on one workspace', () => {
  // The calendar bug: back from Google's consent page (the API's callback wrote the connection), the
  // page showed the old "Connect" state until the leading tab's next poll, up to a minute later.
  it('back from a redirect, the tables it changed show as loading, then the new rows, without waiting for a poll', async () => {
    const connection = { id: 'calc1', provider: 'google', status: 'connected', version: 1 }
    let leader: ReturnType<ReturnType<typeof browser>['tab']> | undefined
    const refresh = vi.fn(async (tables?: readonly string[]) => {
      if (tables?.includes('calendar_connections')) leader!.sink('calendar_connections').upsert([connection] as never)
    })
    const { tab } = browser()
    leader = tab({ refresh }) // the inbox, open in another tab: it leads and polls the settings tables
    await leader.store
    const back = tab({ refreshOnStart: ['calendar_connections', 'assistant_calendars'], refreshWaitMs: 10_000 })
    const page = await back.store
    // The first frame: loading, not the empty list from before the connect.
    expect(page.getSnapshot().refreshing.has('calendar_connections')).toBe(true)
    expect(page.rows('calendar_connections')).toEqual([])
    await eventually(() => {
      expect(page.rows('calendar_connections')).toEqual([connection])
      expect(page.getSnapshot().refreshing.size).toBe(0)
    })
    expect(refresh).toHaveBeenCalledWith(['calendar_connections', 'assistant_calendars'])
    ;(await leader.store).stop(); page.stop()
  })

  it('a tab that does not lead has the leader read again on a write outside the outbox, and when it opens', async () => {
    const refresh = vi.fn(async () => {})
    const { tab } = browser()
    const a = tab({ refresh }), b = tab()
    const [first, second] = [await a.store, await b.store]
    await eventually(() => expect(refresh).toHaveBeenCalledTimes(1)) // the second tab opened
    second.applyResult({ rows: {} }) // e.g. a webhook created with useWriteAction in the second tab
    await eventually(() => expect(refresh).toHaveBeenCalledTimes(2))
    await second.refresh(['calendar_connections'])
    expect(refresh).toHaveBeenLastCalledWith(['calendar_connections'])
    first.stop(); second.stop()
  })

  it('lets only the leading tab sync and send, and shows its rows in the other tab', async () => {
    const sent: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => { sent.push(url.split('/').pop()!); return respond(200, { ok: true, rows: { calls: [call({ inbox_state: 'done', unread: false, version: 5 })] } }) }))
    const { tab } = browser()
    const a = tab(), b = tab()
    const [first, second] = [await a.store, await b.store]
    expect([a.syncStarted(), b.syncStarted()]).toEqual([true, false]) // one set of connections for both tabs
    a.calls().upsert([call()])
    await eventually(() => expect(second.rows('calls')[0]).toMatchObject({ id: 'c1', inbox_state: 'open' }))

    await second.run('call.markDone', { callId: 'c1' }) // issued in the second tab, sent by the first
    expect(second.rows('calls')[0]!.inbox_state).toBe('done') // instant where it was done
    await eventually(() => {
      expect(first.rows('calls')[0]).toMatchObject({ inbox_state: 'done', version: 5 })
      expect(second.rows('calls')[0]).toMatchObject({ inbox_state: 'done', version: 5 })
      expect([first.getSnapshot().pending, second.getSnapshot().pending]).toEqual([0, 0])
    })
    await quietFor()
    expect(sent).toEqual(['call.markDone']) // once, not once per tab
    first.stop(); second.stop()
  })

  it('tells every tab of the workspace when the server refuses it, and the next leader does not start again', async () => {
    const fetchMock = vi.fn(async () => respond(200, { ok: true, rows: {} }))
    vi.stubGlobal('fetch', fetchMock)
    const { tab } = browser()
    const a = tab(), b = tab()
    const [first, second] = [await a.store, await b.store]
    a.calls().refuse({ code: 'workspace_switched', activeWorkspaceId: 'ws_b' })
    await eventually(() => expect(second.getSnapshot().refused).toEqual({ code: 'workspace_switched', activeWorkspaceId: 'ws_b' }))
    first.stop() // the second tab leads now
    await quietFor()
    expect(b.syncStarted()).toBe(false)
    await second.run('call.markDone', { callId: 'c1' })
    await quietFor()
    expect(fetchMock).not.toHaveBeenCalled()
    second.stop()
  })

  it('signed out: the other tab rolls its pending change back too, and hears whether the workspace is disabled', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => respond(401, { ok: false, error: 'not signed in', code: 'signed_out' })))
    const { tab } = browser()
    const a = tab(), b = tab()
    const [first, second] = [await a.store, await b.store]
    a.calls().workspaceState('disabled')
    await eventually(() => expect(second.getSnapshot().workspaceState).toBe('disabled'))
    a.calls().upsert([call()])
    await eventually(() => expect(second.rows('calls')).toHaveLength(1))
    await second.run('call.markDone', { callId: 'c1' }) // sent by the first tab, refused
    await eventually(() => expect(second.getSnapshot()).toMatchObject({ refused: { code: 'signed_out' }, pending: 0, discarded: 1 }))
    expect(second.rows('calls')[0]!.inbox_state).toBe('open')
    first.stop(); second.stop()
  })

  it('a refused leader gives up the lead: a tab opened later for the workspace leads and sends what waited', async () => {
    const sent: string[] = []
    let refuse = true
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      sent.push(url.split('/').pop()!)
      return refuse
        ? respond(403, { ok: false, error: 'switched', code: 'workspace_switched', activeWorkspaceId: 'ws_b' })
        : respond(200, { ok: true, rows: {} })
    }))
    const { tab } = browser()
    const a = tab()
    const first = await a.store
    await first.run('call.markDone', { callId: 'c1' })
    await eventually(() => expect(first.getSnapshot().refused).toMatchObject({ code: 'workspace_switched' }))
    // The session is switched back elsewhere; a new tab of this workspace opens while the refused one stays open.
    refuse = false
    const c = tab()
    const later = await c.store
    await eventually(() => expect(c.syncStarted()).toBe(true)) // it leads: the refused tab let go
    await eventually(() => expect(later.getSnapshot().pending).toBe(0)) // and sent the queued change
    expect(sent).toEqual(['call.markDone', 'call.markDone'])
    first.stop(); later.stop()
  })

  it("does not replay another tab's command when a tab starts while it is on its way", async () => {
    const sent: string[] = []
    let answer: () => void = () => {}
    vi.stubGlobal('fetch', vi.fn((url: string) => new Promise<Response>(resolve => { sent.push(url.split('/').pop()!); answer = () => resolve(respond(200, { ok: true, rows: {} })) })))
    const { tab } = browser()
    const a = tab()
    const first = await a.store
    a.calls().upsert([call()])
    await first.run('call.delete', { callId: 'c1' }) // in flight
    const second = await tab().store // a reload of another tab: it finds the command in the shared outbox
    expect(second.getSnapshot().pending).toBe(1)
    await quietFor()
    expect(sent).toEqual(['call.delete']) // the new tab did not send it again
    answer()
    await eventually(() => expect([first.getSnapshot().pending, second.getSnapshot().pending]).toEqual([0, 0]))
    first.stop(); second.stop()
  })

  it('keeps commands apart that two tabs issue at the same time', async () => {
    const sent: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => { sent.push(`${url.split('/').pop()} ${init.body}`); return respond(200, { ok: true, rows: {} }) }))
    const { tab } = browser()
    const a = tab(), b = tab()
    const [first, second] = [await a.store, await b.store]
    a.calls().upsert([call(), call({ id: 'c2' })])
    await eventually(() => expect(second.rows('calls')).toHaveLength(2))
    await Promise.all([first.run('call.markRead', { callId: 'c1' }), second.run('call.markRead', { callId: 'c2' })])
    await eventually(() => expect(sent).toHaveLength(2))
    await quietFor()
    expect(sent.sort()).toEqual(['call.markRead {"callId":"c1"}', 'call.markRead {"callId":"c2"}']) // neither overwrote the other
    first.stop(); second.stop()
  })

  it('hands unsent commands and the sync to the next tab when the leading tab closes', async () => {
    const sent: string[] = []
    let offline = true
    vi.stubGlobal('fetch', vi.fn(async (url: string) => { if (offline) throw new TypeError('offline'); sent.push(url.split('/').pop()!); return respond(200, { ok: true, rows: {} }) }))
    const { tab } = browser()
    const a = tab(), b = tab()
    const [first, second] = [await a.store, await b.store]
    a.calls().upsert([call()])
    await eventually(() => expect(second.rows('calls')).toHaveLength(1))
    await second.run('call.markDone', { callId: 'c1' })
    await quietFor()
    expect(sent).toEqual([])
    first.stop() // the leading tab is closed while offline
    offline = false
    await eventually(() => {
      expect(b.syncStarted()).toBe(true)
      expect(sent).toEqual(['call.markDone'])
      expect(second.getSnapshot().pending).toBe(0)
    })
    second.stop()
  })

  it('reports a rejection only in the tab that issued the command', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => respond(409, { ok: false, error: 'nope' })))
    const { tab } = browser()
    const onLeader = vi.fn(), onFollower = vi.fn()
    const a = tab({ onReject: onLeader }), b = tab({ onReject: onFollower })
    const [first, second] = [await a.store, await b.store]
    a.calls().upsert([call()])
    await eventually(() => expect(second.rows('calls')).toHaveLength(1))
    await second.run('call.markDone', { callId: 'c1' })
    await eventually(() => expect(second.rows('calls')[0]!.inbox_state).toBe('open'))
    expect(onFollower).toHaveBeenCalledWith(expect.objectContaining({ action: 'call.markDone', error: 'nope' }))
    expect(onLeader).not.toHaveBeenCalled()
    await eventually(() => expect(first.rows('calls')[0]!.inbox_state).toBe('open')) // rolled back in both
    first.stop(); second.stop()
  })

  // Staging: Assistant › Webhook stayed on grey rows in a browser with five tabs open. The leading
  // tab was frozen in the background: it held the lead, so no other tab read anything again.
  it('takes the lead from a leader that does not answer, and the empty table it waited for loads', async () => {
    const { tab } = browser()
    const a = tab()
    const first = await a.store
    a.link.freeze()
    const b = tab({ leaderAnswerMs: 20 })
    const second = await b.store
    expect(second.getSnapshot().synced.has('webhook_endpoints')).toBe(false)
    await eventually(() => expect(b.syncStarted()).toBe(true))
    b.sink('webhook_endpoints').saveCursor({ offset: '0_0', handle: 'h' })
    await eventually(() => expect(second.getSnapshot().synced.has('webhook_endpoints')).toBe(true))
    expect(a.syncing()).toBe(false) // the frozen tab stopped syncing when it lost the lead
    first.stop(); second.stop()
  })

  it('keeps a leader that answers, and hears from it which tables are up to date', async () => {
    const { tab } = browser()
    const a = tab()
    const first = await a.store
    a.sink('webhook_endpoints').saveCursor({ offset: '0_0', handle: 'h' })
    await eventually(() => expect(first.getSnapshot().synced.has('webhook_endpoints')).toBe(true))
    // The cursor on disk is gone (a new app version forgot them), so the new tab learns it from the leader.
    const b = tab({ leaderAnswerMs: 50, syncVersion: 'next' })
    const second = await b.store
    await eventually(() => expect(second.getSnapshot().synced.has('webhook_endpoints')).toBe(true))
    await quietFor(100)
    expect([a.syncing(), b.syncStarted()]).toEqual([true, false])
    first.stop(); second.stop()
  })

  // The setup page's "Set up forwarding" waited forever for a number the leading tab never read (its streams were
  // paused in the background): a refresh says whether the tables were read, so the page can say so instead.
  it('a refresh says whether the leader read the tables in time', async () => {
    let reads = 0
    const { tab } = browser()
    const a = tab({ refresh: async () => { reads++ } })
    const first = await a.store
    const b = tab({ refreshWaitMs: 50 })
    const second = await b.store
    expect(await second.refresh(['phone_numbers'])).toBe(true)
    expect(reads).toBeGreaterThan(0)
    first.stop(); second.stop()

    const hung = browser()
    const c = hung.tab({ refresh: () => new Promise<void>(() => {}) }) // answers pings, never finishes a read
    const third = await c.store
    const d = hung.tab({ refreshWaitMs: 50 })
    const fourth = await d.store
    expect(await fourth.refresh(['phone_numbers'])).toBe(false)
    third.stop(); fourth.stop()
  })

  it('a fresh refresh asked in another tab reaches the leader as fresh', async () => {
    const asked: unknown[][] = []
    const { tab } = browser()
    const a = tab({ refresh: async (...args: unknown[]) => void asked.push(args) })
    const first = await a.store
    const b = tab({ refreshWaitMs: 1000 })
    const second = await b.store
    await eventually(() => expect(asked.length).toBeGreaterThan(0)) // the second tab opened
    asked.length = 0
    expect(await second.refresh(['phone_numbers'], { fresh: true })).toBe(true)
    expect(asked).toEqual([[['phone_numbers'], { fresh: true }]])
    expect(await second.refresh(['phone_numbers'])).toBe(true)
    expect(asked[1]).toEqual([['phone_numbers']])
    first.stop(); second.stop()
  })
})
