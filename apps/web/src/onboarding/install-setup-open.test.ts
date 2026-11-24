import type { InstallSetupState } from '@linedesk/actions'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

// Opening the walkthrough must never save anything: it only changes the address.
const runAdmin = vi.hoisted(() => vi.fn())
vi.mock('../admin/api.ts', async original => ({ ...(await original<typeof import('../admin/api.ts')>()), runAdmin }))

const { INSTALL_SETUP_HASH, openingStep, openInstallSetup } = await import('./InstallSetup.tsx')

type Progress = InstallSetupState['progress']
const progress = (change: Partial<Progress> = {}): Readonly<Progress> =>
  Object.freeze({ step: 'welcome', skipped: [], finishedAt: null, setAsideAt: null, manualBy: [], ...change })

describe('Install walkthrough: where it opens', () => {
  test('complete, then "Step by step": the first part (Email), not the summary', () => {
    const complete = progress({ step: 'done', finishedAt: '2026-11-01T00:00:00Z', skipped: ['telephony'] })
    expect(openingStep(complete, 'start')).toBe('email')
    // Opened any other way it still shows the summary once finished.
    expect(openingStep(complete, 'left')).toBe('done')
  })

  test('started, then "Continue step by step": the step it was left on', () => {
    expect(openingStep(progress({ step: 'telephony' }), 'left')).toBe('telephony')
    expect(openingStep(progress(), 'left')).toBe('welcome')
  })

  test('"Step by step" on a started walkthrough also starts at the first part', () => {
    expect(openingStep(progress({ step: 'call-audio', setAsideAt: '2026-11-01T00:00:00Z' }), 'start')).toBe('email')
  })
})

describe('Install walkthrough: opening it changes nothing saved', () => {
  beforeEach(() => {
    vi.stubGlobal('window', { location: { hash: '#admin/providers' } })
    runAdmin.mockClear()
  })
  afterEach(() => vi.unstubAllGlobals())

  test.each(['start', 'left'] as const)('from %s: only the address changes, no progress or setting is saved', from => {
    const saved = progress({ step: 'done', finishedAt: '2026-11-01T00:00:00Z', skipped: ['email'], manualBy: ['a1'] })
    const before = structuredClone(saved)
    openInstallSetup({ from })
    expect(window.location.hash).toBe(INSTALL_SETUP_HASH)
    openingStep(saved, from)
    expect(saved).toEqual(before)
    expect(runAdmin).not.toHaveBeenCalled()
  })
})
