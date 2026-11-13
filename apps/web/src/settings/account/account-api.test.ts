import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const signedInAccount = vi.fn<() => Promise<string | null>>()
const signInWithPasskey = vi.fn<() => Promise<{ error?: { message?: string } } | undefined>>()
const signOutAndForget = vi.fn(async () => {})
vi.mock('../../auth.ts', () => ({
  auth: {},
  fetchAuthMethods: vi.fn(),
  fetchMe: vi.fn(),
  signedInAccount,
  signInWithPasskey,
}))
vi.mock('../../localData.ts', () => ({ signOutAndForget }))
const { confirmWithPasskey, ConfirmWithPasskey, PasskeyOfAnotherAccount } = await import('./account-api.ts')

describe('confirmWithPasskey', () => {
  const reload = vi.fn()
  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal('window', { location: { reload } })
    signOutAndForget.mockClear()
    reload.mockClear()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('keeps the session when the passkey is the same account\'s', async () => {
    signedInAccount.mockResolvedValue('u1')
    signInWithPasskey.mockResolvedValue({})
    await confirmWithPasskey()
    expect(signOutAndForget).not.toHaveBeenCalled()
  })

  it('signs out, reloads and throws when the passkey belongs to another account', async () => {
    signedInAccount.mockResolvedValueOnce('u1').mockResolvedValueOnce('u2')
    signInWithPasskey.mockResolvedValue({})
    const err = await confirmWithPasskey().catch(e => e)
    expect(err).toBeInstanceOf(PasskeyOfAnotherAccount)
    expect(err).not.toBeInstanceOf(ConfirmWithPasskey)
    expect(err.message).toContain('That passkey belongs to another account')
    expect(signOutAndForget).toHaveBeenCalledOnce()
    vi.runAllTimers()
    expect(reload).toHaveBeenCalledOnce()
  })

  it('a failed passkey sign-in can be tried again and does not sign out', async () => {
    signedInAccount.mockResolvedValue('u1')
    signInWithPasskey.mockResolvedValue({ error: { message: 'cancelled' } })
    await expect(confirmWithPasskey()).rejects.toBeInstanceOf(ConfirmWithPasskey)
    expect(signOutAndForget).not.toHaveBeenCalled()
  })
})
