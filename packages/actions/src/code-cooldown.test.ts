import { describe, expect, test } from 'vitest'
import { CODE_COOLDOWN_RESET_MS, codeCooldownLeftMs, codeCooldownS } from './code-cooldown.ts'

const MIN = 60_000

describe('the cooldown between email codes (LIN-661)', () => {
  test('grows 30 s, 2, 5, then 10 min for every later code', () => {
    expect([0, 1, 2, 3, 4, 5, 9].map(codeCooldownS)).toEqual([0, 30, 120, 300, 600, 600, 600])
  })

  test('counts from the last code, the codes in a row since the last long gap', () => {
    const now = 100 * MIN
    expect(codeCooldownLeftMs([], now)).toBe(0)
    expect(codeCooldownLeftMs([now - 10_000], now)).toBe(20_000)
    expect(codeCooldownLeftMs([now - 3 * MIN, now - MIN], now)).toBe(MIN)
    // Order does not matter.
    expect(codeCooldownLeftMs([now - MIN, now - 3 * MIN], now)).toBe(MIN)
    // A code more than an hour before the others starts no row with them.
    expect(codeCooldownLeftMs([now - CODE_COOLDOWN_RESET_MS - 5 * MIN, now - 10_000], now)).toBe(20_000)
    // An hour after the last code: no wait at all.
    expect(codeCooldownLeftMs([now - CODE_COOLDOWN_RESET_MS], now)).toBe(0)
  })
})
