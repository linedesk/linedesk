import { describe, expect, test } from 'vitest'
import { isLive, isRealCall, nextSetupStep, setupNumber, setupStepPath, takesAllCalls } from './setup-state.ts'

const number = (id: string, mode: 'forward_conditional' | 'forward_all' | 'new' | 'ported', created_at: string) => ({
  id,
  mode,
  created_at,
})

describe('setup state', () => {
  test('the setup number is the oldest forwarding number, else the oldest number', () => {
    const bought = number('pn_new', 'new', '2026-11-01T00:00:00Z')
    const forwarded = number('pn_fwd', 'forward_conditional', '2026-11-02T00:00:00Z')
    const older = number('pn_fwd0', 'forward_all', '2026-10-30T00:00:00Z')
    expect(setupNumber([])).toBeNull()
    expect(setupNumber([bought])).toBe(bought)
    expect(setupNumber([bought, forwarded])).toBe(forwarded)
    expect(setupNumber([forwarded, older, bought])).toBe(older)
  })

  test('only conditional forwarding takes part of the calls', () => {
    expect(takesAllCalls('forward_conditional')).toBe(false)
    expect(takesAllCalls('forward_all')).toBe(true)
    expect(takesAllCalls('new')).toBe(true)
    expect(takesAllCalls('ported')).toBe(true)
  })

  test('only an incoming call from a real caller counts', () => {
    const real = { source: 'phone', direction: 'in', from_own_number: false, outcome: 'message' } as const
    expect(isRealCall(real)).toBe(true)
    expect(isRealCall({ ...real, from_own_number: true })).toBe(false)
    expect(isRealCall({ ...real, outcome: 'spam' })).toBe(false)
    expect(isRealCall({ ...real, direction: 'out' })).toBe(false)
    expect(isRealCall({ ...real, source: 'sample' })).toBe(false)
    expect(isRealCall({ ...real, source: 'test' })).toBe(false)
  })

  test('live: the first real call or activated milestone, or a real call', () => {
    expect(isLive(new Set(), false)).toBe(false)
    expect(isLive(new Set(['forwarding_verified']), false)).toBe(false)
    expect(isLive(new Set(['first_real_call']), false)).toBe(true)
    expect(isLive(new Map([['activated', '2026-11-01']]), false)).toBe(true)
    expect(isLive(new Set(), true)).toBe(true)
  })

  test('the next step: number, forwarding, first call; none once live', () => {
    const forwarded = { mode: 'forward_conditional' } as const
    expect(nextSetupStep({ number: null, forwardingVerified: false, live: false })).toBe('number')
    expect(nextSetupStep({ number: forwarded, forwardingVerified: false, live: false })).toBe('forwarding')
    expect(nextSetupStep({ number: forwarded, forwardingVerified: true, live: false })).toBe('first_call')
    expect(nextSetupStep({ number: { mode: 'new' }, forwardingVerified: false, live: false })).toBe('first_call')
    expect(nextSetupStep({ number: forwarded, forwardingVerified: false, live: true })).toBeNull()
  })

  test('each step opens where it is done', () => {
    expect(setupStepPath('number', null)).toBe('workspace/phone')
    expect(setupStepPath('forwarding', { id: 'pn_1' })).toBe('workspace/phone/pn_1')
    expect(setupStepPath('first_call', { id: 'pn_1' })).toBe('calls')
  })
})
