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

  it('keeps at most maxKeys counting keys, dropping the one that failed longest ago', () => {
    const limiter = createFailureLimiter({ max: 2, windowMs: 60_000, maxKeys: 3 })
    for (const key of ['a', 'b', 'c']) limiter.fail(key, 0)
    limiter.fail('a', 1) // a is now blocked, kept apart
    limiter.fail('d', 2)
    limiter.fail('e', 3)
    expect(['a', 'b', 'c', 'd', 'e'].map(k => limiter.failed(k, 4))).toEqual([2, 0, 1, 1, 1])
  })

  it('never drops a blocked key for a flood of new keys, so a flood does not lift a block', () => {
    const limiter = createFailureLimiter({ max: 2, windowMs: 60_000, maxKeys: 2 })
    limiter.fail('victim', 0)
    limiter.fail('victim', 1)
    for (let i = 0; i < 100; i++) limiter.fail(`flood-${i}`, 10 + i)
    expect(limiter.blocked('victim', 200)).toBe(true)
    expect(limiter.size()).toBe(3)
  })

  it('a flood of new keys still counts new keys while blocked keys are kept', () => {
    const limiter = createFailureLimiter({ max: 2, windowMs: 60_000, maxKeys: 2 })
    for (let i = 0; i < 50; i++) for (const t of [0, 1]) limiter.fail(`blocked-${i}`, t)
    limiter.fail('new', 2)
    limiter.fail('new', 3)
    expect(limiter.blocked('new', 4)).toBe(true)
  })

  it('caps blocked keys at maxBlocked, dropping the oldest block', () => {
    const limiter = createFailureLimiter({ max: 1, windowMs: 60_000, maxKeys: 2, maxBlocked: 2 })
    for (const [i, key] of ['a', 'b', 'c'].entries()) limiter.fail(key, i)
    expect(['a', 'b', 'c'].map(k => limiter.blocked(k, 5))).toEqual([false, true, true])
  })

  it('a lifted block keeps its failures still in the window when it is dropped', () => {
    const limiter = createFailureLimiter({ max: 3, windowMs: 100, maxKeys: 10, maxBlocked: 1 })
    for (const t of [0, 50, 60]) limiter.fail('a', t) // blocked until 100, then 2 failures left
    for (const t of [110, 111, 112]) limiter.fail('b', t) // a's block lifted: dropped from the blocked keys
    expect(limiter.failed('a', 113)).toBe(2)
    limiter.fail('a', 114)
    expect(limiter.blocked('a', 115)).toBe(true)
  })

  it('drops expired keys first', () => {
    const limiter = createFailureLimiter({ max: 2, windowMs: 100, maxKeys: 2 })
    limiter.fail('old', 0)
    limiter.fail('b', 150)
    limiter.fail('c', 160)
    expect([limiter.failed('old', 170), limiter.failed('b', 170), limiter.failed('c', 170)]).toEqual([0, 1, 1])
  })
})

describe('createRateLimiter memory', () => {
  it('keeps at most maxKeys keys and can check without recording', () => {
    const allow = createRateLimiter({ max: 1, windowMs: 60_000, maxKeys: 2 })
    allow('a', 0)
    expect(allow.full('a', 1)).toBe(true)
    expect(allow.full('b', 1)).toBe(false)
    allow('b', 2)
    allow('c', 3) // a goes
    expect([allow.full('a', 4), allow.full('b', 4), allow.full('c', 4)]).toEqual([false, true, true])
  })
})
