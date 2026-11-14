import { describe, expect, it } from 'vitest'
import { showPasskeyFirst } from './passkey-first.ts'

describe('passkey before Email in the setup by hand', () => {
  it('comes before Email while the admin has no passkey', () => {
    expect(showPasskeyFirst('email', { passkeyNeeded: true }, false)).toBe(true)
  })

  it('not once they have one, skipped it, or on another step', () => {
    expect(showPasskeyFirst('email', { passkeyNeeded: false }, false)).toBe(false)
    expect(showPasskeyFirst('email', { passkeyNeeded: true }, true)).toBe(false)
    expect(showPasskeyFirst('welcome', { passkeyNeeded: true }, false)).toBe(false)
    expect(showPasskeyFirst('answering', { passkeyNeeded: true }, false)).toBe(false)
    expect(showPasskeyFirst(null, null, false)).toBe(false)
  })

  it('an older API without the field: no passkey screen', () => {
    expect(showPasskeyFirst('email', {} as { passkeyNeeded: boolean }, false)).toBe(false)
  })
})
