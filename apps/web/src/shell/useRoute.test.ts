import { describe, expect, it } from 'vitest'
import { callHash, parseHash } from './useRoute.ts'

describe('route parsing', () => {
  it('reads the list, a call and the pages from the hash', () => {
    expect(parseHash('')).toEqual({ route: 'calls', callId: null })
    expect(parseHash('#calls')).toEqual({ route: 'calls', callId: null })
    expect(parseHash('#call/call_demo_02')).toEqual({ route: 'calls', callId: 'call_demo_02' })
    expect(parseHash(callHash('abc'))).toEqual({ route: 'calls', callId: 'abc' })
    expect(parseHash('#assistant')).toEqual({ route: 'assistant', callId: null })
    expect(parseHash('#account')).toEqual({ route: 'account', callId: null })
  })
  it('falls back to the list for unknown and inherited names', () => {
    for (const hash of ['#nope', '#toString', '#constructor', '#__proto__', '#hasOwnProperty', '#call/']) {
      expect(parseHash(hash)).toEqual({ route: 'calls', callId: null })
    }
  })
})
