import { describe, expect, test } from 'vitest'
import { readDismissed, rememberDismissed, secondPasskeyText, showSecondPasskeyNote } from './SecondPasskeyNote.tsx'

const memory = () => {
  const items = new Map<string, string>()
  return { getItem: (k: string) => items.get(k) ?? null, setItem: (k: string, v: string) => void items.set(k, v) }
}

describe('the second passkey note on Server admin', () => {
  test('recommends, never enforces: only with exactly one passkey, and only until dismissed', () => {
    expect(showSecondPasskeyNote(1, false)).toBe(true)
    expect(showSecondPasskeyNote(1, true)).toBe(false)
    expect(showSecondPasskeyNote(2, false)).toBe(false)
    expect(showSecondPasskeyNote(0, false)).toBe(false)
    // Not loaded yet (or the list failed): no note.
    expect(showSecondPasskeyNote(null, false)).toBe(false)
  })

  test('says why in one sentence', () => {
    expect(secondPasskeyText()).toBe(
      'Add a second passkey, e.g. on your phone or a security key, so a lost device does not lock you out.',
    )
  })

  test('dismissing is remembered per account in this browser', () => {
    const store = memory()
    expect(readDismissed('u1', store)).toBe(false)
    rememberDismissed('u1', store)
    expect(readDismissed('u1', store)).toBe(true)
    expect(readDismissed('u2', store)).toBe(false)
  })

  test('a browser without storage shows the note and dismisses for the visit, without throwing', () => {
    const broken = {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      },
    }
    expect(readDismissed('u1', broken)).toBe(false)
    expect(() => rememberDismissed('u1', broken)).not.toThrow()
    expect(readDismissed('u1', null)).toBe(false)
  })
})
