import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  clearSignedIn,
  markSignedIn,
  PAUSE_DAYS,
  type PasskeyAskInput,
  passkeyAsk,
  pause,
  pausedAt,
  signedInJustNow,
} from './passkey-ask.ts'
import { rememberSignInMethod } from './sign-in-methods.ts'

const DAY = 24 * 60 * 60 * 1000
const NOW = Date.UTC(2026, 10, 14, 12)

const base: PasskeyAskInput = {
  hasPasskey: false,
  supported: true,
  impersonating: false,
  emailUnconfirmed: false,
  needsEnrolmentCode: false,
  justSignedIn: false,
  pausedAt: null,
  now: NOW,
}
const ask = (change: Partial<PasskeyAskInput>) => passkeyAsk({ ...base, ...change })

function memoryStorage() {
  const memory = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => memory.get(k) ?? null,
    setItem: (k: string, v: string) => memory.set(k, v),
    removeItem: (k: string) => memory.delete(k),
  })
  return memory
}

afterEach(() => vi.unstubAllGlobals())

describe('when to ask for a passkey', () => {
  it('asks with the page right after a sign-in without one, else with the card', () => {
    expect(ask({ justSignedIn: true })).toBe('prompt')
    expect(ask({})).toBe('nudge')
  })

  it('never asks someone who has one, or where passkeys are off or unknown', () => {
    expect(ask({ hasPasskey: true, justSignedIn: true })).toBeNull()
    expect(ask({ hasPasskey: null, justSignedIn: true })).toBeNull()
    expect(ask({ hasPasskey: undefined })).toBeNull()
  })

  it('never asks where it cannot work: no browser support, impersonating, address not confirmed', () => {
    expect(ask({ supported: false, justSignedIn: true })).toBeNull()
    expect(ask({ impersonating: true })).toBeNull()
    expect(ask({ emailUnconfirmed: true, justSignedIn: true })).toBeNull()
  })

  it(`waits ${PAUSE_DAYS} days after "Not now", then asks again`, () => {
    expect(ask({ pausedAt: NOW - DAY, justSignedIn: true })).toBeNull()
    expect(ask({ pausedAt: NOW - (PAUSE_DAYS * DAY - 1) })).toBeNull()
    expect(ask({ pausedAt: NOW - PAUSE_DAYS * DAY })).toBe('nudge')
    expect(ask({ pausedAt: NOW - 30 * DAY, justSignedIn: true })).toBe('prompt')
  })

  it('ignores a "Not now" from the future (a wrong clock) rather than never asking again', () => {
    expect(ask({ pausedAt: NOW + 365 * DAY })).toBe('nudge')
  })

  it('sends an admin who needs an enrolment code to the card, not the page', () => {
    expect(ask({ needsEnrolmentCode: true, justSignedIn: true })).toBe('nudge')
  })
})

describe('what this device remembers', () => {
  it('a sign-in another way makes the page due; a passkey sign-in does not', () => {
    memoryStorage()
    expect(signedInJustNow()).toBe(false)
    rememberSignInMethod('email')
    expect(signedInJustNow()).toBe(true)
    rememberSignInMethod('passkey')
    expect(signedInJustNow()).toBe(false)
    markSignedIn('google')
    expect(signedInJustNow()).toBe(true)
    clearSignedIn()
    expect(signedInJustNow()).toBe(false)
  })

  it('"Not now" is per account and answers the page', () => {
    memoryStorage()
    markSignedIn('email')
    pause('acc_1', NOW)
    expect(pausedAt('acc_1')).toBe(NOW)
    expect(pausedAt('acc_2')).toBeNull()
    expect(signedInJustNow()).toBe(false)
  })

  it('works without storage (private window): nothing is remembered, nothing fails', () => {
    const blocked = () => {
      throw new DOMException('denied', 'SecurityError')
    }
    vi.stubGlobal('localStorage', { getItem: blocked, setItem: blocked, removeItem: blocked })
    expect(() => pause('acc_1')).not.toThrow()
    expect(() => markSignedIn('email')).not.toThrow()
    expect(pausedAt('acc_1')).toBeNull()
    expect(signedInJustNow()).toBe(false)
  })
})
