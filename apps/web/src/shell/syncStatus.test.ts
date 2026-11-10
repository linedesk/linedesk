import { describe, expect, it } from 'vitest'
import { syncStatusText } from './syncStatus.ts'

describe('sync bar text', () => {
  it('says what is waiting while offline', () => {
    expect(syncStatusText({ online: false, pending: 3 })).toBe('Offline · 3 changes waiting')
    expect(syncStatusText({ online: false, pending: 1 })).toBe('Offline · 1 change waiting')
    expect(syncStatusText({ online: false, pending: 0 })).toBe('Offline · changes will sync when you are back')
  })
  it('counts down after reconnecting and then goes away', () => {
    expect(syncStatusText({ online: true, pending: 2 })).toBe('Back online · syncing 2…')
    expect(syncStatusText({ online: true, pending: 0 })).toBeNull()
  })
})
