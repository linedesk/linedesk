import { describe, expect, it } from 'vitest'
import { forgetEnrolmentCode, readEnrolmentCode, rememberEnrolmentCode } from './enrolment-code.ts'

/** A Storage in memory. */
function memory(): Storage {
  const items = new Map<string, string>()
  return {
    get length() {
      return items.size
    },
    clear: () => items.clear(),
    getItem: k => items.get(k) ?? null,
    key: i => [...items.keys()][i] ?? null,
    removeItem: k => void items.delete(k),
    setItem: (k, v) => void items.set(k, v),
  }
}

const inAnHour = () => new Date(Date.now() + 3_600_000).toISOString()

describe('the first admin enrolment code', () => {
  it('is kept until the passkey is added', () => {
    const store = memory()
    rememberEnrolmentCode({ enrolmentCode: 'abc123', enrolmentExpiresAt: inAnHour() }, store)
    expect(readEnrolmentCode(store)).toBe('abc123')
    forgetEnrolmentCode(store)
    expect(readEnrolmentCode(store)).toBeNull()
  })

  it('keeps nothing when the setup returns none', () => {
    const store = memory()
    rememberEnrolmentCode(null, store)
    rememberEnrolmentCode(undefined, store)
    expect(store.length).toBe(0)
  })

  it('drops an expired or broken code', () => {
    const store = memory()
    rememberEnrolmentCode(
      { enrolmentCode: 'abc123', enrolmentExpiresAt: new Date(Date.now() - 1000).toISOString() },
      store,
    )
    expect(readEnrolmentCode(store)).toBeNull()
    expect(store.length).toBe(0)
    store.setItem('linedesk.passkeyEnrolment', '{not json')
    expect(readEnrolmentCode(store)).toBeNull()
    expect(store.length).toBe(0)
  })

  it('works without storage (blocked)', () => {
    const blocked = {
      getItem: () => {
        throw new DOMException('denied', 'SecurityError')
      },
      setItem: () => {
        throw new DOMException('denied', 'SecurityError')
      },
      removeItem: () => {
        throw new DOMException('denied', 'SecurityError')
      },
    } as unknown as Storage
    expect(() => rememberEnrolmentCode({ enrolmentCode: 'x', enrolmentExpiresAt: inAnHour() }, blocked)).not.toThrow()
    expect(readEnrolmentCode(blocked)).toBeNull()
  })
})
