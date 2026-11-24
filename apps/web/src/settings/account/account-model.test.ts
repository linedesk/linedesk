import { describe, expect, it } from 'vitest'
import { describeDevice, hasPassword, orderSessions, passwordProblem } from './account-model.ts'

describe('sign-in methods', () => {
  it('knows whether a password is set', () => {
    expect(hasPassword([{ providerId: 'credential' }])).toBe(true)
    expect(hasPassword([{ providerId: 'google' }])).toBe(false)
  })
})

describe('describeDevice', () => {
  it.each([
    [
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36',
      'Chrome on macOS',
    ],
    [
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Safari/605.1.15',
      'Safari on macOS',
    ],
    [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36 Edg/152.0.0.0',
      'Edge on Windows',
    ],
    ['Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0', 'Firefox on Linux'],
    [
      'Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Mobile/15E148 Safari/604.1',
      'Safari on iOS',
    ],
    [
      'Mozilla/5.0 (Linux; Android 16; Pixel 10) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Mobile Safari/537.36',
      'Chrome on Android',
    ],
    ['curl/8.7.1', 'API client'],
    ['node', 'API client'],
    ['', 'Unknown device'],
    [null, 'Unknown device'],
  ])('%s', (userAgent, label) => {
    expect(describeDevice(userAgent)).toBe(label)
  })
})

describe('orderSessions', () => {
  const session = (id: string, lastActive: string, current = false) => ({
    id,
    device: 'Chrome on macOS',
    lastActive: new Date(lastActive),
    current,
  })

  it('puts this device first, then the most recently used', () => {
    const list = [
      session('old', '2026-11-01T10:00:00Z'),
      session('current', '2026-11-05T10:00:00Z', true),
      session('new', '2026-11-09T10:00:00Z'),
    ]
    expect(orderSessions(list).map(s => s.id)).toEqual(['current', 'new', 'old'])
  })

  it('does not change the list it was given', () => {
    const list = [session('a', '2026-11-01T10:00:00Z'), session('b', '2026-11-09T10:00:00Z')]
    orderSessions(list)
    expect(list.map(s => s.id)).toEqual(['a', 'b'])
  })
})

describe('passwordProblem', () => {
  const form = { current: 'old-password', next: 'new-password', repeat: 'new-password' }

  it('accepts a complete change', () => {
    expect(passwordProblem(form, true)).toBeNull()
  })

  it('needs the current password only when there is one', () => {
    expect(passwordProblem({ ...form, current: '' }, true)).toMatch(/current password/)
    expect(passwordProblem({ ...form, current: '' }, false)).toBeNull()
  })

  it('rejects short, mismatched and unchanged passwords', () => {
    expect(passwordProblem({ ...form, next: 'short', repeat: 'short' }, true)).toMatch(/at least 8/)
    expect(passwordProblem({ ...form, repeat: 'something-else' }, true)).toMatch(/do not match/)
    expect(passwordProblem({ current: 'same-password', next: 'same-password', repeat: 'same-password' }, true)).toMatch(
      /same as the current/,
    )
  })
})
