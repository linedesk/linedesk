// A change that happens while the page is away (an OAuth round trip: the provider sends the browser
// to the API's callback, which writes rows, then back to the app) is not in the local store when the
// page comes back, and the store would show what it had before. Before leaving, the page names the
// tables the round trip changes; the store that opens on return shows them as loading until it has
// read them again (StoreOptions.refreshOnStart), so the first frame never shows the old state.
import { type TableName, tableNames } from '@linedesk/db/types'

const KEY = 'linedesk.refreshOnReturn'

function read(storage: Storage): TableName[] {
  try {
    const parsed: unknown = JSON.parse(storage.getItem(KEY) ?? '[]')
    return Array.isArray(parsed) ? tableNames.filter(t => parsed.includes(t)) : []
  } catch {
    return []
  }
}

/** Call right before leaving for a redirect that writes these tables on the server. */
export function refreshOnReturn(tables: readonly TableName[], storage: Storage = sessionStorage) {
  try {
    storage.setItem(KEY, JSON.stringify([...new Set([...read(storage), ...tables])]))
  } catch {
    // Private mode: the tables are read on return anyway, only without the loading state.
  }
}

/** On page load: the tables to read before showing them, once (a reload later shows them as usual). */
export function takeRefreshOnReturn(storage: Storage = sessionStorage): TableName[] {
  const tables = read(storage)
  try {
    storage.removeItem(KEY)
  } catch {}
  return tables
}
