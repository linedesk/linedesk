// Local-first store. Confirmed rows come only from the server (read sync or an action's
// response); pending commands live in a durable outbox and are re-applied on top of the
// confirmed rows on every change, so the UI is instant and survives reloads and offline.
// With several tabs open, one tab leads: it sends the outbox and runs read sync (see tabs.ts).
import { actions, applyLocally, type ActionResult, type LocalTables } from '@linedesk/actions'
import { tableNames, type TableName, type Tables } from '@linedesk/db/types'
import type { ReadSyncAdapter, TableSink } from './adapter.ts'
import { type LocalDb, openLocalDb } from './idb.ts'
import {
  keepsPendingWrites,
  refusalOf,
  type WorkspaceRefusal,
  workspaceRequestHeaders,
  type WorkspaceState,
  workspaceStateOf,
} from './refusal.ts'
import { browserTabLink, type Command, type TabLink, type TabMessage } from './tabs.ts'

type AnyRow = { id: string; version: number }
/**
 * `synced`: tables that have caught up with the server at least once (now or in an earlier session). Before that, an empty table means "not loaded yet", not "nothing there".
 * `refused`: the server refuses this workspace for this tab, or the session is gone; nothing is sent or read any more.
 * `discarded`: pending writes rolled back because of that. `workspaceState`: the latest the server said (null: nothing yet).
 */
export type Snapshot = {
  tables: LocalTables
  pending: number
  online: boolean
  synced: ReadonlySet<TableName>
  refused: WorkspaceRefusal | null
  discarded: number
  workspaceState: WorkspaceState | null
  /**
   * Tables being read again because something changed them outside the outbox (a redirect back from
   * a provider): what is local may be out of date, so the UI shows them as loading, never the old state.
   */
  refreshing: ReadonlySet<TableName>
}
export type Rejection = { action: string; input: unknown; error: string }

export interface StoreOptions {
  api: string
  dbName: string
  /** The workspace of this store: sent with every action, so the server never runs it in another one. */
  workspaceId?: string
  /** The account this page was opened for: sent with every action, and the local database's rows belong to it. */
  account?: string
  adapter: ReadSyncAdapter
  onReject?: (r: Rejection) => void
  /** The local database was taken away by another tab (it signed out). The store has stopped. */
  onLocalDbLost?: () => void
  retryMs?: number
  /** The app's build. When it changes (a new deploy), every table loads afresh: read-sync cursors are dropped, pending writes kept. */
  appVersion?: string
  /** How this store finds the other tabs of the workspace. Default: Web Lock and BroadcastChannel named after the database. */
  tabs?: TabLink
  /**
   * Tables changed on the server while this page was away (a redirect back from an OAuth provider):
   * shown as loading from the first frame until they are read again (see `refreshAfterWrite`).
   */
  refreshOnStart?: readonly TableName[]
  /** How long a table waited for may show as loading at most; then the local rows show anyway. */
  refreshWaitMs?: number
  /** A click or key press in this tab reads the polled tables again once they are older than this. */
  activityRefreshMs?: number
}

const emptyTables = () => Object.fromEntries(tableNames.map(t => [t, new Map()])) as unknown as LocalTables
/** Microseconds since 1970; commands stored by older versions only have `at`. */
const seqOf = (c: Command) => c.seq ?? Date.parse(c.at) * 1000
/** Oldest first. Within a tab `seq` never repeats; between tabs the id breaks ties, so every tab agrees on the order. */
const byAge = (a: Command, b: Command) => seqOf(a) - seqOf(b) || a.id.localeCompare(b.id)

const VERSION_KEY = 'appVersion'
/** A refresh nobody answers (the leading tab closed meanwhile) stops showing tables as loading after this. */
const REFRESH_WAIT_MS = 4000
/**
 * A tab someone keeps looking at gets no focus event: a member removed meanwhile would see the
 * workspace until the next long-poll or poll (up to a minute). Their next click or key press reads
 * the polled tables again, at most this often, so the server's refusal arrives before they act on old data.
 */
const ACTIVITY_REFRESH_MS = 15_000

/** A new build may sync a different shape of the tables: drop the read-sync cursors so each table loads again. */
export async function forgetCursorsOnNewVersion(local: LocalDb, version: string): Promise<boolean> {
  const meta = await local.all<unknown>('meta')
  if (meta.find(([key]) => key === VERSION_KEY)?.[1] === version) return false
  await local.write('meta', s => {
    for (const [key] of meta) if (String(key).startsWith('cursor:')) s.delete(key)
    s.put(version, VERSION_KEY)
  })
  return true
}

const ACCOUNT_KEY = 'account'

/**
 * The local database belongs to one account. Opened for another one (someone else signed in on this
 * browser without signing the first out), it is emptied first: the first account's rows are not shown
 * and its unsent changes are never sent as the second. A database from before this marker (whose
 * account is unknown) keeps its rows, which the read sync replaces anyway, but not its unsent changes.
 */
export async function claimForAccount(local: LocalDb, account: string): Promise<boolean> {
  const owner = (await local.all<unknown>('meta')).find(([key]) => key === ACCOUNT_KEY)?.[1]
  if (owner === account) return false
  const stores = owner === undefined ? (['outbox'] as const) : ([...tableNames, 'outbox', 'meta'] as const)
  for (const store of stores) await local.write(store, s => s.clear())
  await local.write('meta', s => s.put(account, ACCOUNT_KEY))
  return true
}

/**
 * The tabs that share one leader: same database and same account. Another account's tabs on this
 * browser (someone signed in in another tab) never follow a leader that sends as the first account.
 */
export const tabGroupName = (dbName: string, account?: string) => `linedesk-tabs:${dbName}${account ? `:${account}` : ''}`

export async function createStore(opts: StoreOptions) {
  let stopped = false
  /** Out of the tab group (see leaveTabs). */
  let leftTabs = false
  let leading = false
  const tabs = opts.tabs ?? browserTabLink(tabGroupName(opts.dbName, opts.account))
  const early: TabMessage[] = [] // messages that arrive while the database is still loading
  let receive = (message: TabMessage) => {
    early.push(message)
  }
  tabs.onMessage(message => receive(message))

  const local = await openLocalDb(opts.dbName, {
    onLost: () => {
      stop()
      opts.onLocalDbLost?.()
    },
  })
  if (opts.account) await claimForAccount(local, opts.account)
  if (opts.appVersion) await forgetCursorsOnNewVersion(local, opts.appVersion)
  const confirmed = emptyTables()
  let outbox: Command[] = []
  /** The key each command is stored under: its id (older versions stored a per-tab counter). */
  const storedKey = new Map<string, IDBValidKey>()
  /** Commands issued by this tab: only this tab reports their rejection to the user. */
  const mine = new Set<string>()
  let online = true
  let refused: WorkspaceRefusal | null = null
  /** When every polled table was last asked for (start counts as asked: the first reads are running). */
  let refreshedAt = Date.now()
  /** Pending writes rolled back because the session or the workspace was refused. */
  let discarded = 0
  let workspaceState: WorkspaceState | null = null
  const synced = new Set<TableName>()
  /** Tables shown as loading until a refresh answers, with how many refreshes wait for each. */
  const refreshing = new Map<TableName, number>()
  /** This tab's refreshes the leader is reading for, by request id. */
  const askedLeader = new Map<string, { tables?: readonly TableName[]; answered: () => void }>()
  let lastSeq = 0
  let snapshot: Snapshot
  const listeners = new Set<() => void>()

  async function loadFromDisk() {
    for (const t of tableNames)
      confirm(
        t,
        (await local.all<AnyRow>(t)).map(([, row]) => row),
        false,
      )
    for (const [key, cursor] of await local.all<unknown>('meta')) {
      const table = String(key).replace(/^cursor:/, '') as TableName
      if (cursor && String(key).startsWith('cursor:') && tableNames.includes(table)) synced.add(table)
    }
    const stored = await local.all<Command>('outbox')
    for (const [key, c] of stored) storedKey.set(c.id, key)
    const known = new Set(outbox.map(c => c.id))
    outbox = [...outbox, ...stored.map(([, c]) => c).filter(c => !known.has(c.id))].sort(byAge)
  }

  function recompute() {
    const tables = Object.fromEntries(
      tableNames.map(t => [t, new Map(confirmed[t] as Map<string, AnyRow>)]),
    ) as unknown as LocalTables
    for (const c of outbox) {
      const def = actions.get(c.name)
      if (def) applyLocally(tables, def, c.input, c.at)
    }
    snapshot = {
      tables,
      pending: outbox.length,
      online,
      synced: new Set(synced),
      refused,
      discarded,
      workspaceState,
      refreshing: new Set(refreshing.keys()),
    }
    listeners.forEach(l => l())
  }

  /** Never let an older row version overwrite a newer one (action responses and sync race). */
  function confirm(table: TableName, rows: AnyRow[], persist = true) {
    const map = confirmed[table] as Map<string, AnyRow>
    const fresh = rows.filter(r => (map.get(r.id)?.version ?? -1) <= r.version)
    for (const r of fresh) map.set(r.id, r)
    if (persist && fresh.length) void local.write(table, s => fresh.forEach(r => s.put(r, r.id)))
  }
  function removeRows(table: TableName, ids: string[], persist = true) {
    for (const id of ids) confirmed[table].delete(id)
    if (persist) void local.write(table, s => ids.forEach(id => s.delete(id)))
  }
  function replaceRows(table: TableName, rows: AnyRow[], persist = true) {
    confirmed[table] = new Map(rows.map(r => [r.id, r])) as never
    if (persist)
      void local.write(table, s => {
        s.clear()
        rows.forEach(r => s.put(r, r.id))
      })
  }

  /** Rows an action deleted on the server: gone here and in the other tabs at once. */
  function removeDeleted(deleted: ActionResult['deleted']) {
    for (const [table, ids] of Object.entries(deleted ?? {})) {
      if (!ids?.length) continue
      removeRows(table as TableName, ids)
      tabs.post({ type: 'remove', table: table as TableName, ids })
    }
  }

  /**
   * The result of an action that ran directly, not through the outbox (it needed the server's answer
   * first): its rows and deletions show at once, here and in the other tabs.
   */
  function applyResult(result: Pick<ActionResult, 'rows' | 'deleted'>) {
    if (stopped) return
    for (const [table, rows] of Object.entries(result.rows ?? {})) {
      confirm(table as TableName, rows as AnyRow[])
      tabs.post({ type: 'upsert', table: table as TableName, rows: rows as AnyRow[] })
    }
    removeDeleted(result.deleted)
    recompute()
    void refresh() // what the action changed besides its rows (in a tab that does not lead too)
  }

  /**
   * Read sync runs in the leading tab only; what it brings is passed on to the other tabs. Once refused,
   * an answer still on its way is dropped (it may come after another account emptied the database).
   */
  const sinkFor = <T extends TableName>(table: T): TableSink<T> => ({
    upsert(rows) {
      if (stopped || refused) return
      confirm(table, rows as AnyRow[])
      tabs.post({ type: 'upsert', table, rows: rows as AnyRow[] })
      recompute()
    },
    remove(ids) {
      if (stopped || refused) return
      removeRows(table, ids)
      tabs.post({ type: 'remove', table, ids })
      recompute()
    },
    replaceAll(rows) {
      if (stopped || refused) return
      replaceRows(table, rows as AnyRow[])
      tabs.post({ type: 'replace', table, rows: rows as AnyRow[] })
      recompute()
    },
    loadCursor: async () => (await local.all('meta')).find(([k]) => k === `cursor:${table}`)?.[1],
    saveCursor: cursor => {
      if (stopped || refused) return
      void local.write('meta', s => s.put(cursor, `cursor:${table}`))
      if (cursor && !synced.has(table)) markSynced(table)
    },
    refuse,
    workspaceState: setWorkspaceState,
  })

  /**
   * The server refuses this tab's workspace, or the session is gone: stop reading and sending; the
   * other tabs of the workspace hear it too. After a switch, pending writes stay in the outbox for when
   * this workspace is opened again; otherwise they can never be sent and are rolled back (`discarded`).
   */
  function refuse(refusal: WorkspaceRefusal) {
    if (stopped || refused) return
    refused = refusal
    stops.forEach(s => s())
    stops = []
    clearTimeout(retry)
    if (!keepsPendingWrites(refusal)) discardOutbox()
    tabs.post({ type: 'refused', refusal })
    leaveTabs()
    recompute()
  }

  /** Rolls every pending write back: it shows no more, and is gone from the disk. */
  function discardOutbox() {
    discarded += outbox.length
    outbox = []
    mine.clear()
    storedKey.clear()
    void local.write('outbox', s => s.clear())
  }

  function setWorkspaceState(state: WorkspaceState) {
    if (stopped || workspaceState === state) return
    workspaceState = state
    if (!leftTabs) tabs.post({ type: 'workspace-state', state })
    recompute()
  }

  /**
   * Out of the workspace's tab group: a refused tab must not keep the lead (a tab opened later for this
   * workspace would follow a leader that never sends or reads), nor take it later. Queued writes stay
   * on disk for the next leader.
   */
  function leaveTabs() {
    if (leftTabs) return
    leftTabs = true
    tabs.close()
  }

  function forget(id: string) {
    outbox = outbox.filter(c => c.id !== id)
    mine.delete(id)
  }
  /** The leader is done with a command: off the disk, and every tab hears the result. */
  async function settle(c: Command, result: { rows?: ActionResult['rows']; error?: string }) {
    forget(c.id)
    recompute() // this tab shows the result as soon as the others do, not after the disk write
    tabs.post({ type: 'settled', id: c.id, ...result })
    await local.write('outbox', s => s.delete(storedKey.get(c.id) ?? c.id))
    storedKey.delete(c.id)
  }

  function markSynced(table: TableName) {
    synced.add(table)
    tabs.post({ type: 'synced', table })
    recompute()
  }

  function setOnline(value: boolean) {
    if (online === value) return
    online = value
    if (leading) tabs.post({ type: 'online', online })
    recompute()
  }

  let flushing = false
  let retry: ReturnType<typeof setTimeout> | undefined
  const retryLater = () => {
    clearTimeout(retry)
    retry = setTimeout(() => void flush(), opts.retryMs ?? 2000)
  }

  /**
   * Send pending commands in order (the leading tab only). Stops at the first transient failure to keep order.
   * Always takes the oldest command still waiting, so one added while a request is in flight is sent too.
   */
  async function flush() {
    if (flushing || stopped || refused || !leading) return
    flushing = true
    try {
      for (let c = outbox[0]; c; c = outbox[0]) {
        let res: Response
        try {
          res = await fetch(`${opts.api}/v1/actions/${c.name}`, {
            method: 'POST',
            credentials: 'include',
            // Ahead of the read sync's requests when the browser has to queue them.
            priority: 'high',
            body: JSON.stringify(c.input),
            headers: {
              'content-type': 'application/json',
              'idempotency-key': c.id,
              ...workspaceRequestHeaders({ workspaceId: opts.workspaceId, account: opts.account }),
            },
          })
        } catch {
          if (stopped) return
          setOnline(false)
          return retryLater()
        }
        if (stopped) return // answered after stop(): the next leader replays the command (same idempotency key)
        if (res.status >= 500) {
          setOnline(false)
          return retryLater()
        }
        setOnline(true)
        const state = workspaceStateOf(res.headers)
        if (state) setWorkspaceState(state)
        const body = (await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }))) as
          | ActionResult
          | { ok: false; error: string }
        if (stopped) return
        // Not a rejection of this command: signed out, or the tab's workspace is refused. Retrying cannot help.
        const refusal = refusalOf(res.status, body)
        if (refusal) return refuse(refusal)
        // A 401 that is not the API's own (a proxy in front of it): no verdict on this command, try again later.
        if (res.status === 401) return retryLater()
        if (body.ok) {
          for (const [table, rows] of Object.entries(body.rows)) confirm(table as TableName, rows as AnyRow[])
          removeDeleted(body.deleted)
        } else if (mine.has(c.id)) {
          opts.onReject?.({ action: c.name, input: c.input, error: body.error }) // dropping it rolls the UI back
        }
        await settle(c, body.ok ? { rows: body.rows } : { error: body.error })
        // A write can change tables that are not followed live (a deleted row is not in the answer).
        if (body.ok) void readNow()
      }
    } finally {
      flushing = false
    }
  }

  /** Run an action: applied locally at once, sent to the server in the background (by the leading tab). */
  async function run(name: string, input: unknown) {
    const def = actions.get(name)
    if (!def) throw new Error(`unknown action ${name}`)
    // Signed out or no access: it could never be sent, so it is not even queued.
    if (refused && !keepsPendingWrites(refused)) {
      discarded++
      return recompute()
    }
    const now = Date.now()
    lastSeq = Math.max(now * 1000, lastSeq + 1, ...outbox.map(seqOf).map(s => s + 1)) // two commands in one millisecond keep their order
    const command: Command = {
      id: crypto.randomUUID(),
      name,
      input: def.input.parse(input),
      at: new Date(now).toISOString(),
      seq: lastSeq,
    }
    mine.add(command.id)
    outbox.push(command)
    recompute()
    await local.write('outbox', s => s.put(command, command.id)) // durable before sending
    tabs.post({ type: 'added', command })
    void flush()
  }

  /** The leading tab reads the tables now; resolves once they are up to date. */
  async function readNow(tables?: readonly TableName[]) {
    await opts.adapter.refresh?.(tables)
  }

  /** A tab that does not lead asks the leader to read; resolves when the leader says it has. */
  function askLeader(tables?: readonly TableName[]): Promise<void> {
    const id = crypto.randomUUID()
    const answered = new Promise<void>(resolve => askedLeader.set(id, { tables, answered: resolve }))
    tabs.post({ type: 'refresh', id, ...(tables ? { tables: [...tables] } : {}) })
    return answered
  }

  function markRefreshing(tables: readonly TableName[], by: 1 | -1) {
    for (const t of tables) {
      const count = (refreshing.get(t) ?? 0) + by
      if (count > 0) refreshing.set(t, count)
      else refreshing.delete(t)
    }
    recompute()
  }

  /**
   * Reads the tables that are not followed live again now (all, or these), in whichever tab leads.
   * With `wait`, the tables show as loading until then (at most `refreshWaitMs`): for a change made
   * outside the outbox whose rows this tab has not got, so the UI never shows the state from before.
   */
  async function refresh(tables?: readonly TableName[], { wait = false }: { wait?: boolean } = {}) {
    if (stopped || refused) return
    if (!tables) refreshedAt = Date.now()
    const waited = wait ? (tables ?? tableNames) : []
    if (waited.length) markRefreshing(waited, 1)
    let timer: ReturnType<typeof setTimeout> | undefined
    const capped = new Promise<void>(resolve => {
      timer = setTimeout(resolve, opts.refreshWaitMs ?? REFRESH_WAIT_MS)
    })
    try {
      await Promise.race([leading ? readNow(tables) : askLeader(tables), capped])
    } finally {
      clearTimeout(timer)
      if (waited.length && !stopped) markRefreshing(waited, -1)
    }
  }

  /** What another tab did or learned. */
  function onTabMessage(m: TabMessage) {
    if (stopped) return
    if (m.type === 'added') {
      if (!outbox.some(c => c.id === m.command.id)) outbox = [...outbox, m.command].sort(byAge)
      void flush()
    } else if (m.type === 'settled') {
      const command = outbox.find(c => c.id === m.id)
      for (const [table, rows] of Object.entries(m.rows ?? {})) confirm(table as TableName, rows as AnyRow[], false)
      if (command && m.error && mine.has(m.id))
        opts.onReject?.({ action: command.name, input: command.input, error: m.error })
      forget(m.id)
    } else if (m.type === 'upsert') confirm(m.table, m.rows, false)
    else if (m.type === 'replace') replaceRows(m.table, m.rows, false)
    else if (m.type === 'remove') removeRows(m.table, m.ids, false)
    else if (m.type === 'online' && !leading) online = m.online
    else if (m.type === 'synced') synced.add(m.table)
    else if (m.type === 'refused' && !refused) {
      refused = m.refusal
      if (!keepsPendingWrites(m.refusal)) {
        discarded += outbox.length // the leader cleared the disk; this tab rolls back what it shows
        outbox = []
        mine.clear()
      }
      leaveTabs() // a follower must not take the lead of a refused workspace either
    } else if (m.type === 'workspace-state') workspaceState = m.state
    else if (m.type === 'refresh') {
      if (leading) void readNow(m.tables).then(() => tabs.post({ type: 'refreshed', id: m.id }))
      return
    } else if (m.type === 'refreshed') {
      askedLeader.get(m.id)?.answered()
      askedLeader.delete(m.id)
      return
    }
    recompute()
  }

  let stops: (() => void)[] = []
  /** True until createStore returns: a tab that leads from the start has just read the disk. */
  let starting = true
  /** This tab now talks to the server: at start when it is alone, later when the leading tab closed. */
  async function lead() {
    if (stopped || leading) return
    leading = true
    if (!starting) await loadFromDisk() // what the previous leader wrote, and commands whose announcement this tab missed
    if (stopped) return
    recompute()
    if (refused) return // the leader before was refused: this one would be too
    stops = tableNames.map(t => opts.adapter.start(t, sinkFor(t)))
    // What this tab asked the leader before (it was not leading yet, or the leader closed): read it now.
    for (const [id, ask] of askedLeader) {
      askedLeader.delete(id)
      void readNow(ask.tables).then(ask.answered)
    }
    void flush()
  }

  const onOnline = () => void flush()
  /** Back in this tab (focus, or the page shown again): what changed meanwhile shows at once. */
  const onBack = () => {
    if (globalThis.document?.visibilityState !== 'hidden') void refresh()
  }
  const onActivity = () => {
    if (Date.now() - refreshedAt >= (opts.activityRefreshMs ?? ACTIVITY_REFRESH_MS)) void refresh()
  }
  function stop() {
    if (stopped) return
    stopped = true
    stops.forEach(s => s())
    clearTimeout(retry)
    for (const ask of askedLeader.values()) ask.answered()
    askedLeader.clear()
    globalThis.removeEventListener?.('online', onOnline)
    globalThis.removeEventListener?.('focus', onBack)
    globalThis.document?.removeEventListener('visibilitychange', onBack)
    globalThis.removeEventListener?.('pointerdown', onActivity, true)
    globalThis.removeEventListener?.('keydown', onActivity, true)
    leaveTabs() // hands the lead to another tab
    local.close()
  }

  await loadFromDisk()
  const startWait = opts.refreshOnStart?.length ? opts.refreshOnStart : null
  if (startWait) markRefreshing(startWait, 1) // from the first frame, before any read
  recompute()
  receive = onTabMessage
  early.forEach(onTabMessage)
  globalThis.addEventListener?.('online', onOnline)
  globalThis.addEventListener?.('focus', onBack)
  globalThis.document?.addEventListener('visibilitychange', onBack)
  globalThis.addEventListener?.('pointerdown', onActivity, true)
  globalThis.addEventListener?.('keydown', onActivity, true)
  tabs.whenLeading(() => void lead())
  starting = false
  // A tab that opens while another leads: the leader's polled tables may be a minute old.
  if (!leading) tabs.post({ type: 'refresh', id: crypto.randomUUID() })
  // Back from a redirect: read those tables (in this tab once it leads, else in the leader), then show them.
  if (startWait) void refresh(startWait).finally(() => markRefreshing(startWait, -1))

  return {
    run,
    flush,
    applyResult,
    /**
     * Asks the server for changes now: after a write that did not go through the outbox and whose
     * result does not carry every row it changed. `{ wait: true }` shows the tables as loading until then.
     */
    refresh,
    subscribe: (l: () => void) => {
      listeners.add(l)
      return () => {
        listeners.delete(l)
      }
    },
    getSnapshot: () => snapshot,
    rows: <T extends TableName>(table: T): Tables[T][] => [...snapshot.tables[table].values()],
    stop,
  }
}
export type Store = Awaited<ReturnType<typeof createStore>>
