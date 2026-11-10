import { describe, expect, it } from 'vitest'
import { createRateLimiter } from './rate-limit.ts'

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
