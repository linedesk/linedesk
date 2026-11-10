// Local-first store. Confirmed rows come only from the server (read sync or an action's
// response); pending commands live in a durable outbox and are re-applied on top of the
// confirmed rows on every change, so the UI is instant and survives reloads and offline.
// With several tabs open, one tab leads: it sends the outbox and runs read sync (see tabs.ts).
import { actions, applyLocally, type ActionResult, type LocalTables } from '@callfront/actions'
import { tableNames, type TableName, type Tables } from '@callfront/db/types'
import type { ReadSyncAdapter, TableSink } from './adapter.ts'
import { openLocalDb } from './idb.ts'
import { browserTabLink, type Command, type TabLink, type TabMessage } from './tabs.ts'

type AnyRow = { id: string; version: number }
export type Snapshot = { tables: LocalTables; pending: number; online: boolean }
export type Rejection = { action: string; input: unknown; error: string }

export interface StoreOptions {
  api: string
  dbName: string
  adapter: ReadSyncAdapter
  onReject?: (r: Rejection) => void
  /** The local database was taken away by another tab (it signed out). The store has stopped. */
  onLocalDbLost?: () => void
  retryMs?: number
  /** How this store finds the other tabs of the workspace. Default: Web Lock and BroadcastChannel named after the database. */
  tabs?: TabLink
}

const emptyTables = () => Object.fromEntries(tableNames.map(t => [t, new Map()])) as unknown as LocalTables
/** Microseconds since 1970; commands stored by older versions only have `at`. */
const seqOf = (c: Command) => c.seq ?? Date.parse(c.at) * 1000
/** Oldest first. Within a tab `seq` never repeats; between tabs the id breaks ties, so every tab agrees on the order. */
const byAge = (a: Command, b: Command) => seqOf(a) - seqOf(b) || a.id.localeCompare(b.id)

export async function createStore(opts: StoreOptions) {
  let stopped = false
  let leading = false
  const tabs = opts.tabs ?? browserTabLink(`callfront-tabs:${opts.dbName}`)
  const early: TabMessage[] = [] // messages that arrive while the database is still loading
  let receive = (message: TabMessage) => { early.push(message) }
  tabs.onMessage(message => receive(message))

  const local = await openLocalDb(opts.dbName, { onLost: () => { stop(); opts.onLocalDbLost?.() } })
  const confirmed = emptyTables()
  let outbox: Command[] = []
  /** The key each command is stored under: its id (older versions stored a per-tab counter). */
  const storedKey = new Map<string, IDBValidKey>()
  /** Commands issued by this tab: only this tab reports their rejection to the user. */
  const mine = new Set<string>()
  let online = true
  let lastSeq = 0
  let snapshot: Snapshot
  const listeners = new Set<() => void>()

  async function loadFromDisk() {
    for (const t of tableNames) confirm(t, (await local.all<AnyRow>(t)).map(([, row]) => row), false)
    const stored = await local.all<Command>('outbox')
    for (const [key, c] of stored) storedKey.set(c.id, key)
    const known = new Set(outbox.map(c => c.id))
    outbox = [...outbox, ...stored.map(([, c]) => c).filter(c => !known.has(c.id))].sort(byAge)
  }

  function recompute() {
    const tables = Object.fromEntries(tableNames.map(t => [t, new Map(confirmed[t] as Map<string, AnyRow>)])) as unknown as LocalTables
    for (const c of outbox) {
      const def = actions.get(c.name)
      if (def) applyLocally(tables, def, c.input, c.at)
    }
    snapshot = { tables, pending: outbox.length, online }
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
    if (persist) void local.write(table, s => { s.clear(); rows.forEach(r => s.put(r, r.id)) })
  }

  /** Read sync runs in the leading tab only; what it brings is passed on to the other tabs. */
  const sinkFor = <T extends TableName>(table: T): TableSink<T> => ({
    upsert(rows) {
      if (stopped) return
      confirm(table, rows as AnyRow[])
      tabs.post({ type: 'upsert', table, rows: rows as AnyRow[] })
      recompute()
    },
    remove(ids) {
      if (stopped) return
      removeRows(table, ids)
      tabs.post({ type: 'remove', table, ids })
      recompute()
    },
    replaceAll(rows) {
      if (stopped) return
      replaceRows(table, rows as AnyRow[])
      tabs.post({ type: 'replace', table, rows: rows as AnyRow[] })
      recompute()
    },
    loadCursor: async () => (await local.all('meta')).find(([k]) => k === `cursor:${table}`)?.[1],
    saveCursor: cursor => stopped ? undefined : void local.write('meta', s => s.put(cursor, `cursor:${table}`)),
  })

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

  function setOnline(value: boolean) {
    if (online === value) return
    online = value
    if (leading) tabs.post({ type: 'online', online })
    recompute()
  }

  let flushing = false
  let retry: ReturnType<typeof setTimeout> | undefined
  const retryLater = () => { clearTimeout(retry); retry = setTimeout(() => void flush(), opts.retryMs ?? 2000) }

  /**
   * Send pending commands in order (the leading tab only). Stops at the first transient failure to keep order.
   * Always takes the oldest command still waiting, so one added while a request is in flight is sent too.
   */
  async function flush() {
    if (flushing || stopped || !leading) return
    flushing = true
    try {
      for (let c = outbox[0]; c; c = outbox[0]) {
        let res: Response
        try {
          res = await fetch(`${opts.api}/v1/actions/${c.name}`, {
            method: 'POST', credentials: 'include', body: JSON.stringify(c.input),
            headers: { 'content-type': 'application/json', 'idempotency-key': c.id },
          })
        } catch { if (stopped) return; setOnline(false); return retryLater() }
        if (stopped) return // answered after stop(): the next leader replays the command (same idempotency key)
        if (res.status >= 500 || res.status === 401) { setOnline(res.status === 401); return retryLater() }
        setOnline(true)
        const body = (await res.json()) as ActionResult | { ok: false; error: string }
        if (stopped) return
        if (body.ok) {
          for (const [table, rows] of Object.entries(body.rows)) confirm(table as TableName, rows as AnyRow[])
        } else if (mine.has(c.id)) {
          opts.onReject?.({ action: c.name, input: c.input, error: body.error }) // dropping it rolls the UI back
        }
        await settle(c, body.ok ? { rows: body.rows } : { error: body.error })
      }
    } finally { flushing = false }
  }

  /** Run an action: applied locally at once, sent to the server in the background (by the leading tab). */
  async function run(name: string, input: unknown) {
    const def = actions.get(name)
    if (!def) throw new Error(`unknown action ${name}`)
    const now = Date.now()
    lastSeq = Math.max(now * 1000, lastSeq + 1, ...outbox.map(seqOf).map(s => s + 1)) // two commands in one millisecond keep their order
    const command: Command = { id: crypto.randomUUID(), name, input: def.input.parse(input), at: new Date(now).toISOString(), seq: lastSeq }
    mine.add(command.id)
    outbox.push(command)
    recompute()
    await local.write('outbox', s => s.put(command, command.id)) // durable before sending
    tabs.post({ type: 'added', command })
    void flush()
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
      if (command && m.error && mine.has(m.id)) opts.onReject?.({ action: command.name, input: command.input, error: m.error })
      forget(m.id)
    } else if (m.type === 'upsert') confirm(m.table, m.rows, false)
    else if (m.type === 'replace') replaceRows(m.table, m.rows, false)
    else if (m.type === 'remove') removeRows(m.table, m.ids, false)
    else if (m.type === 'online' && !leading) online = m.online
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
    stops = tableNames.map(t => opts.adapter.start(t, sinkFor(t)))
    void flush()
  }

  const onOnline = () => void flush()
  function stop() {
    if (stopped) return
    stopped = true
    stops.forEach(s => s())
    clearTimeout(retry)
    globalThis.removeEventListener?.('online', onOnline)
    tabs.close() // hands the lead to another tab
    local.close()
  }

  await loadFromDisk()
  recompute()
  receive = onTabMessage
  early.forEach(onTabMessage)
  globalThis.addEventListener?.('online', onOnline)
  tabs.whenLeading(() => void lead())
  starting = false

  return {
    run,
    flush,
    subscribe: (l: () => void) => { listeners.add(l); return () => { listeners.delete(l) } },
    getSnapshot: () => snapshot,
    rows: <T extends TableName>(table: T): Tables[T][] => [...snapshot.tables[table].values()],
    stop,
  }
}
export type Store = Awaited<ReturnType<typeof createStore>>
