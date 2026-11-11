import { describe, expect, it } from 'vitest'
import { createFailureLimiter, createRateLimiter } from './rate-limit.ts'

describe('createRateLimiter', () => {
  it('allows up to max hits per key inside the window, then refuses', () => {
    const allow = createRateLimiter({ max: 2, windowMs: 1000 })
    expect([allow('a', 0), allow('a', 10), allow('a', 20)]).toEqual([true, true, false])
  })

  it('counts each key on its own', () => {
    const allow = createRateLimiter({ max: 1, windowMs: 1000 })
    expect([allow('a', 0), allow('b', 0), allow('a', 1)]).toEqual([true, true, false])
  })

  it('allows again once the window has passed', () => {
    const allow = createRateLimiter({ max: 1, windowMs: 1000 })
    expect([allow('a', 0), allow('a', 999), allow('a', 1000)]).toEqual([true, false, true])
  })

  it('does not let refused hits extend the block', () => {
    const allow = createRateLimiter({ max: 1, windowMs: 1000 })
    allow('a', 0)
    allow('a', 900)
    expect(allow('a', 1000)).toBe(true)
  })
})

describe('createFailureLimiter', () => {
  it('blocks a key after max failures in the window, without counting the checks', () => {
    const limiter = createFailureLimiter({ max: 2, windowMs: 1000 })
    limiter.fail('a', 0)
    expect(limiter.blocked('a', 10)).toBe(false)
    limiter.fail('a', 20)
    expect([limiter.blocked('a', 30), limiter.blocked('b', 30), limiter.blocked('a', 1020)]).toEqual([
      true,
      false,
      false,
    ])
  })

  it('keeps at most maxKeys keys, dropping the one that failed longest ago', () => {
    const limiter = createFailureLimiter({ max: 1, windowMs: 60_000, maxKeys: 3 })
    for (const key of ['a', 'b', 'c']) limiter.fail(key, 0)
    limiter.fail('a', 1) // a is now the newest
    limiter.fail('d', 2)
    expect(limiter.size()).toBe(3)
    expect(['a', 'b', 'c', 'd'].map(k => limiter.blocked(k, 3))).toEqual([true, false, true, true])
  })
})
