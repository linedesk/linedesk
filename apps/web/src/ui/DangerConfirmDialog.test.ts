import { describe, expect, it } from 'vitest'
import { confirmFailureText } from './DangerConfirmDialog.tsx'

describe('the danger dialog after a failed run', () => {
  const signIn = Object.assign(new Error('Sign in again first.'), { code: 'SIGN_IN_AGAIN' })
  const explains = (err: unknown) => (err as { code?: unknown }).code === 'SIGN_IN_AGAIN'

  it('says why in its error note', () => {
    expect(confirmFailureText(new Error('The workspace is busy.'))).toBe('The workspace is busy.')
  })

  it('adds no note of its own for a refusal the caller explains (its "Sign in again" note)', () => {
    expect(confirmFailureText(signIn, explains)).toBeNull()
    expect(confirmFailureText(new Error('The workspace is busy.'), explains)).toBe('The workspace is busy.')
  })
})
