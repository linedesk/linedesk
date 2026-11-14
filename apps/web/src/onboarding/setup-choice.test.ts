import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../admin/api.ts', () => ({ runAdmin: vi.fn(async () => ({})) }))
const { choseManualSetup, rememberManual } = await import('./setup-choice.ts')
const { runAdmin } = await import('../admin/api.ts')

beforeEach(() => {
  // What an earlier install left in this browser (LIN-181).
  const memory = new Map<string, string>([['linedesk.setup.manual', '1']])
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => memory.get(k) ?? null,
    setItem: (k: string, v: string) => memory.set(k, v),
    removeItem: (k: string) => memory.delete(k),
  })
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.mocked(runAdmin).mockClear()
})

describe('set up by hand: the choice belongs to the admin and the install', () => {
  it('a new install opens on the agent setup page, whatever this browser kept from before', () => {
    expect(choseManualSetup({ setupByHand: false }, false)).toBe(false)
    expect(choseManualSetup({}, false)).toBe(false)
    expect(choseManualSetup(null, false)).toBe(false)
  })

  it('this admin chose by hand on this install: the walkthrough or their business, not the agent page', () => {
    expect(choseManualSetup({ setupByHand: true }, false)).toBe(true)
  })

  it('another admin, or the same person on another install: the server says no, so the agent page', () => {
    // /v1/me.setupByHand is per admin and per install (apps/api/test/install-setup.test.ts).
    expect(choseManualSetup({ setupByHand: false }, false)).toBe(false)
  })

  it('chosen just now in this tab counts before /v1/me is read again', () => {
    expect(choseManualSetup({ setupByHand: false }, true)).toBe(true)
  })

  it('remembers the choice on the server, never in the browser', async () => {
    rememberManual(true)
    rememberManual(false)
    expect(vi.mocked(runAdmin).mock.calls).toEqual([
      ['install.setProgress', { manual: true }],
      ['install.setProgress', { manual: false }],
    ])
    expect(localStorage.getItem('linedesk.setup.manual')).toBe('1') // untouched and unread
  })

  it('a failed save does not throw: the choice lasts this page', async () => {
    vi.mocked(runAdmin).mockRejectedValueOnce(new Error('offline'))
    expect(() => rememberManual(true)).not.toThrow()
    await Promise.resolve()
  })
})
