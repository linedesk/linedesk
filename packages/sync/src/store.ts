// Local-first store. Confirmed rows come only from the server (read sync or an action's
// response); pending commands live in a durable outbox and are re-applied on top of the
// confirmed rows on every change, so the UI is instant and survives reloads and offline.
import { actions, applyLocally, type ActionResult, type LocalTables } from '@callfront/actions'
import { tableNames, type TableName, type Tables } from '@callfront/db/types'
import type { ReadSyncAdapter, TableSink } from './adapter.ts'
import { openLocalDb } from './idb.ts'

type Command = { id: string; key: number; name: string; input: unknown; at: string }
type AnyRow = { id: string; version: number }
export type Snapshot = { tables: LocalTables; pending: number; online: boolean }
export type Rejection = { action: string; input: unknown; error: string }

export interface StoreOptions {
  api: string
  dbName: string
  adapter: ReadSyncAdapter
  onReject?: (r: Rejection) => void
  retryMs?: number
}

const emptyTables = () => Object.fromEntries(tableNames.map(t => [t, new Map()])) as unknown as LocalTables

export async function createStore(opts: StoreOptions) {
  const local = await openLocalDb(opts.dbName)
  const confirmed = emptyTables()
  for (const t of tableNames) {
    for (const [, row] of await local.all<AnyRow>(t)) (confirmed[t] as Map<string, AnyRow>).set(row.id, row)
  }
  let outbox = (await local.all<Command>('outbox')).map(([, c]) => c).sort((a, b) => a.key - b.key)
  let nextKey = Math.max(0, ...outbox.map(c => c.key)) + 1
  let online = true
  let snapshot: Snapshot
  const listeners = new Set<() => void>()

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
  function confirm(table: TableName, rows: AnyRow[]) {
    const map = confirmed[table] as Map<string, AnyRow>
    const fresh = rows.filter(r => (map.get(r.id)?.version ?? -1) <= r.version)
    for (const r of fresh) map.set(r.id, r)
    if (fresh.length) void local.write(table, s => fresh.forEach(r => s.put(r, r.id)))
  }

  const sinkFor = <T extends TableName>(table: T): TableSink<T> => ({
    upsert(rows) { confirm(table, rows as AnyRow[]); recompute() },
    remove(ids) {
      for (const id of ids) confirmed[table].delete(id)
      void local.write(table, s => ids.forEach(id => s.delete(id)))
      recompute()
    },
    replaceAll(rows) {
      confirmed[table] = new Map((rows as AnyRow[]).map(r => [r.id, r])) as never
      void local.write(table, s => { s.clear(); (rows as AnyRow[]).forEach(r => s.put(r, r.id)) })
      recompute()
    },
    loadCursor: async () => (await local.all('meta')).find(([k]) => k === `cursor:${table}`)?.[1],
    saveCursor: cursor => void local.write('meta', s => s.put(cursor, `cursor:${table}`)),
  })

  async function drop(c: Command) {
    outbox = outbox.filter(x => x !== c)
    await local.write('outbox', s => s.delete(c.key))
  }

  function setOnline(value: boolean) {
    if (online === value) return
    online = value
    recompute()
  }

  let flushing = false
  let retry: ReturnType<typeof setTimeout> | undefined
  const retryLater = () => { clearTimeout(retry); retry = setTimeout(() => void flush(), opts.retryMs ?? 2000) }

  /** Replay pending commands in order. Stops at the first transient failure to keep order. */
  async function flush() {
    if (flushing) return
    flushing = true
    try {
      for (const c of [...outbox]) {
        let res: Response
        try {
          res = await fetch(`${opts.api}/v1/actions/${c.name}`, {
            method: 'POST', credentials: 'include', body: JSON.stringify(c.input),
            headers: { 'content-type': 'application/json', 'idempotency-key': c.id },
          })
        } catch { setOnline(false); return retryLater() }
        if (res.status >= 500 || res.status === 401) { setOnline(res.status === 401); return retryLater() }
        setOnline(true)
        const body = (await res.json()) as ActionResult | { ok: false; error: string }
        if (body.ok) {
          for (const [table, rows] of Object.entries(body.rows)) confirm(table as TableName, rows as AnyRow[])
        } else {
          opts.onReject?.({ action: c.name, input: c.input, error: body.error }) // dropping it rolls the UI back
        }
        await drop(c)
        recompute()
      }
    } finally { flushing = false }
  }

  /** Run an action: applied locally at once, sent to the server in the background. */
  async function run(name: string, input: unknown) {
    const def = actions.get(name)
    if (!def) throw new Error(`unknown action ${name}`)
    const command: Command = { id: crypto.randomUUID(), key: nextKey++, name, input: def.input.parse(input), at: new Date().toISOString() }
    outbox.push(command)
    recompute()
    await local.write('outbox', s => s.put(command, command.key)) // durable before sending
    void flush()
  }

  recompute()
  const stops = tableNames.map(t => opts.adapter.start(t, sinkFor(t)))
  const onOnline = () => void flush()
  globalThis.addEventListener?.('online', onOnline)
  void flush()

  return {
    run,
    flush,
    subscribe: (l: () => void) => { listeners.add(l); return () => { listeners.delete(l) } },
    getSnapshot: () => snapshot,
    rows: <T extends TableName>(table: T): Tables[T][] => [...snapshot.tables[table].values()],
    stop() {
      stops.forEach(stop => stop())
      clearTimeout(retry)
      globalThis.removeEventListener?.('online', onOnline)
      local.close()
    },
  }
}
export type Store = Awaited<ReturnType<typeof createStore>>
