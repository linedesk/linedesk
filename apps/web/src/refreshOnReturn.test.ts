import { describe, expect, it } from 'vitest'
import { refreshOnReturn, takeRefreshOnReturn } from './refreshOnReturn.ts'

function memoryStorage(): Storage {
  const map = new Map<string, string>()
  return {
    getItem: k => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: k => void map.delete(k),
    clear: () => map.clear(),
    key: i => [...map.keys()][i] ?? null,
    get length() {
      return map.size
    },
  }
}

describe('tables to read again after a redirect', () => {
  it('are kept across the round trip and taken once', () => {
    const storage = memoryStorage()
    refreshOnReturn(['calendar_connections', 'assistant_calendars'], storage)
    refreshOnReturn(['calendar_connections'], storage)
    expect(takeRefreshOnReturn(storage)).toEqual(['calendar_connections', 'assistant_calendars'])
    expect(takeRefreshOnReturn(storage)).toEqual([]) // a reload later loads as usual
  })

  it('ignores what is not a synced table', () => {
    const storage = memoryStorage()
    storage.setItem('linedesk.refreshOnReturn', JSON.stringify(['calls', 'nope']))
    expect(takeRefreshOnReturn(storage)).toEqual(['calls'])
    storage.setItem('linedesk.refreshOnReturn', '{broken')
    expect(takeRefreshOnReturn(storage)).toEqual([])
  })
})
