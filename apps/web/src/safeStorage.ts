// localStorage and sessionStorage that never throw: a private window, a full or blocked storage, or an old value that is
// no JSON any more read as nothing and write nothing. What is kept there is a convenience (where a setup was, a choice
// made in this browser), never a record, so losing it only means starting from the default.

export type StorageArea = 'local' | 'session'

const areaOf = (area: StorageArea): Storage => (area === 'local' ? localStorage : sessionStorage)

/** The text kept under `key`, or null (nothing kept, or the storage can't be read). */
export function readStored(area: StorageArea, key: string): string | null {
  try {
    return areaOf(area).getItem(key)
  } catch {
    return null
  }
}

/** Keeps `value` under `key`; null removes it. */
export function writeStored(area: StorageArea, key: string, value: string | null): void {
  try {
    if (value === null) areaOf(area).removeItem(key)
    else areaOf(area).setItem(key, value)
  } catch {
    // Blocked or full: nothing kept, the default comes back next time.
  }
}

/** The JSON kept under `key`, or null (nothing kept, unreadable, or not JSON). */
export function readStoredJson<T>(area: StorageArea, key: string): T | null {
  try {
    return JSON.parse(readStored(area, key) ?? 'null') as T | null
  } catch {
    return null
  }
}

/** Keeps `value` as JSON under `key`; null removes it. */
export const writeStoredJson = (area: StorageArea, key: string, value: unknown): void =>
  writeStored(area, key, value === null || value === undefined ? null : JSON.stringify(value))

/** A yes/no kept per id (`prefix` + id) in this browser: '1' when on, nothing when off. */
export function storedFlag(prefix: string) {
  return {
    on: (id: string) => readStored('local', prefix + id) === '1',
    set: (id: string, on: boolean) => writeStored('local', prefix + id, on ? '1' : null),
  }
}
