// The Start your free trial link (trialLink.ts, onboarding/TrialLink.tsx; docs/billing.md §3.2): what it asks for, and
// that it leaves the address once taken, keeping the rest of the hash.
import { trialStartHashPath } from '@linedesk/actions'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { Activation, Me } from './auth.ts'

vi.mock('./onboarding/SetupRowActions.tsx', () => ({ StartTrialDialog: () => null }))
vi.mock('./team/members.ts', () => ({ useMembers: () => [] }))
const { readTrialLink, takeAlreadyRunning, takeTrialLink, withoutTrialLink } = await import('./trialLink.ts')
const { trialLinkRequest } = await import('./onboarding/TrialLink.tsx')

const hashOf = (path: string) => path.slice(path.indexOf('#'))

describe('the link', () => {
  test('the API and the app read the same address; the interval is optional and only month or year', () => {
    const yearly = hashOf(trialStartHashPath('ws_1', 'year'))
    expect(trialStartHashPath('ws_1', 'year')).toBe('/#workspace/billing?start-trial=1&interval=year&ws=ws_1')
    expect(readTrialLink(yearly)).toEqual({ interval: 'year' })
    expect(readTrialLink(hashOf(trialStartHashPath('ws_1')))).toEqual({ interval: null })
    expect(readTrialLink('#workspace/billing?start-trial=1&interval=weekly')).toEqual({ interval: null })
    expect(readTrialLink('#workspace/billing?cancel=1')).toBeNull()
    expect(readTrialLink('#workspace/billing')).toBeNull()
  })

  test('taken out of the address: only its own parameters go, the rest stays', () => {
    expect(withoutTrialLink('#workspace/billing?start-trial=1&interval=month&ws=ws_1')).toBe(
      '#workspace/billing?ws=ws_1',
    )
    expect(withoutTrialLink('#workspace/billing?start-trial=1')).toBe('#workspace/billing')
  })
})

describe('taking it from the page', () => {
  const replaced: string[] = []
  function page(hash: string) {
    replaced.length = 0
    vi.stubGlobal('window', {
      location: { pathname: '/', search: '', hash },
      history: { state: null, replaceState: (_: unknown, __: string, url: string) => replaced.push(url) },
    })
  }
  afterEach(() => vi.unstubAllGlobals())

  test('the flag leaves the address at once (replaceState, no history entry)', () => {
    page('#workspace/billing?start-trial=1&interval=year')
    expect(takeTrialLink()).toEqual({ interval: 'year' })
    expect(replaced).toEqual(['/#workspace/billing'])
  })

  test('a waiting workspace lands on the app’s start instead of a Settings page it does not have yet', () => {
    page('#workspace/billing?start-trial=1')
    takeTrialLink('')
    expect(replaced).toEqual(['/'])
  })

  test('no link: the address is not touched', () => {
    page('#calls')
    expect(takeTrialLink()).toBeNull()
    expect(replaced).toEqual([])
  })

  test('the "already running" note is said once', () => {
    expect(takeAlreadyRunning()).toBe(false)
  })
})

describe('what it opens for whom', () => {
  const activation = { planCents: 1100, interval: 'month' } as Activation
  const me = (workspace: Partial<NonNullable<Me['workspace']>>) =>
    ({ workspace: { id: 'ws_1', name: 'Brightwater', ...workspace } }) as Me
  const link = '#workspace/billing?start-trial=1&interval=year'

  test('the owner of a workspace waiting for its trial: the dialog, with the link’s interval', () => {
    expect(trialLinkRequest(me({ billingState: 'pending_payment', activation }), link)).toEqual({
      kind: 'start',
      interval: 'year',
    })
  })

  test('someone who cannot start it (no activation facts for them): who can', () => {
    expect(trialLinkRequest(me({ billingState: 'pending_payment', activation: null }), link)).toEqual({
      kind: 'notOwner',
    })
  })

  test('a trial or plan that runs already: no dialog (Settings › Billing says so)', () => {
    expect(trialLinkRequest(me({ billingState: 'active', activation: null }), link)).toBeNull()
    expect(trialLinkRequest(me({ billingState: null }), link)).toBeNull()
  })

  test('no link: nothing', () => {
    expect(trialLinkRequest(me({ billingState: 'pending_payment', activation }), '#calls')).toBeNull()
  })
})
