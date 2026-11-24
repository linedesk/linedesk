import { describe, expect, it } from 'vitest'
import { syncStatusText } from './syncStatus.ts'

describe('sync bar text', () => {
  it('always says that changes will sync once the app is back online', () => {
    expect(syncStatusText({ online: false, pending: 3 })).toBe("Offline · 3 changes will sync when you're back online")
    expect(syncStatusText({ online: false, pending: 1 })).toBe("Offline · 1 change will sync when you're back online")
    expect(syncStatusText({ online: false, pending: 0 })).toBe("Offline · your changes will sync when you're back online")
  })
  it('counts down after reconnecting and then goes away', () => {
    expect(syncStatusText({ online: true, pending: 2 })).toBe('Back online · syncing 2…')
    expect(syncStatusText({ online: true, pending: 0 })).toBeNull()
  })
})
