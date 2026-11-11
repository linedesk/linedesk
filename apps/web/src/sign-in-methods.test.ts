import { afterEach, describe, expect, it, vi } from 'vitest'
import { readLastUsedMethod, rememberSignInMethod } from './sign-in-methods.ts'

afterEach(() => vi.unstubAllGlobals())

describe('last used sign-in method', () => {
  it('remembers the method on this device', () => {
    const memory = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => memory.get(k) ?? null,
      setItem: (k: string, v: string) => memory.set(k, v),
    })
    expect(readLastUsedMethod()).toBeNull()
    rememberSignInMethod('google')
    expect(readLastUsedMethod()).toBe('google')
  })

  it('shows no badge and does not fail when storage is blocked', () => {
    const blocked = () => {
      throw new DOMException('denied', 'SecurityError')
    }
    vi.stubGlobal('localStorage', { getItem: blocked, setItem: blocked })
    expect(() => rememberSignInMethod('email')).not.toThrow()
    expect(readLastUsedMethod()).toBeNull()
  })
})
