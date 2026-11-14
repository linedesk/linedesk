import { describe, expect, test, vi } from 'vitest'
import { runAdmin } from '../admin/api.ts'
import { StepUpRequired } from '../admin/PasskeyStepUp.tsx'
import { PASSKEY_CANCELLED } from '../sign-in-code.ts'
import { allowWithPasskey, PASSKEYS_NEED_HTTPS } from './allow-email-and-sign-in.ts'

const refused = () =>
  new Response(
    JSON.stringify({
      ok: false,
      error: 'Confirm with your passkey to do this.',
      code: 'PASSKEY_STEP_UP_REQUIRED',
      stepUp: 'confirm',
    }),
    {
      status: 403,
    },
  )

describe('Allow on the agent setup page', () => {
  test('the old way: runAdmin on this page (no step-up dialog mounted) never asks for the passkey', async () => {
    // What Allow did before: the server asks for the passkey, but the dialog that would ask for it lives in the admin
    // area, so the refusal went straight back to the page and no passkey prompt ever showed.
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(refused())
    await expect(runAdmin('agentSetup.confirmPasskey', { keyId: 'sk_1' })).rejects.toBeInstanceOf(StepUpRequired)
    expect(fetch).toHaveBeenCalledTimes(1)
    fetch.mockRestore()
  })

  test('asks for the passkey first, then stores the grant for the key the link names', async () => {
    const order: string[] = []
    const signIn = vi.fn(async () => {
      order.push('passkey')
      return { data: {} }
    })
    const confirm = vi.fn(async (keyId: string) => {
      order.push(`confirm ${keyId}`)
      return { keyId, emailAndSignInUntil: '2026-11-15T10:00:00.000Z' }
    })
    const result = await allowWithPasskey('sk_1', { supported: () => true, signIn, confirm })
    expect(order).toEqual(['passkey', 'confirm sk_1'])
    expect(result).toEqual({ ok: true, until: '2026-11-15T10:00:00.000Z' })
  })

  test('a cancelled passkey prompt allows nothing and says so calmly', async () => {
    const confirm = vi.fn()
    const result = await allowWithPasskey('sk_1', {
      supported: () => true,
      signIn: async () => ({ error: { code: PASSKEY_CANCELLED } }),
      confirm,
    })
    expect(confirm).not.toHaveBeenCalled()
    expect(result).toMatchObject({ ok: false, cancelled: true })
    // The prompt closed by the browser or the device (Better Auth passes the WebAuthn error's code): the same.
    const closed = await allowWithPasskey('sk_1', {
      supported: () => true,
      signIn: async () => ({ error: { code: 'ERROR_PASSTHROUGH_SEE_CAUSE_PROPERTY', status: 400 } }),
      confirm,
    })
    expect(confirm).not.toHaveBeenCalled()
    expect(closed).toMatchObject({ ok: false, cancelled: true })
  })

  test('a passkey prompt that throws allows nothing', async () => {
    const confirm = vi.fn()
    const result = await allowWithPasskey('sk_1', {
      supported: () => true,
      signIn: () => Promise.reject(new TypeError('Failed to fetch')),
      confirm,
    })
    expect(confirm).not.toHaveBeenCalled()
    expect(result).toMatchObject({ ok: false, cancelled: false })
  })

  test('no passkeys in this browser: nothing is asked or stored', async () => {
    const signIn = vi.fn()
    const confirm = vi.fn()
    expect(await allowWithPasskey('sk_1', { supported: () => false, signIn, confirm })).toEqual({
      ok: false,
      cancelled: false,
      message: PASSKEYS_NEED_HTTPS,
    })
    expect(signIn).not.toHaveBeenCalled()
    expect(confirm).not.toHaveBeenCalled()
  })

  test('the server still refusing after the passkey is said, never swallowed', async () => {
    const signIn = async () => ({ data: {} })
    const stepUp = await allowWithPasskey('sk_1', {
      supported: () => true,
      signIn,
      confirm: () => Promise.reject(new StepUpRequired('Confirm with your passkey to do this.', 'confirm')),
    })
    expect(stepUp).toMatchObject({ ok: false, cancelled: false, message: expect.stringMatching(/did not count/) })
    const enrol = await allowWithPasskey('sk_1', {
      supported: () => true,
      signIn,
      confirm: () => Promise.reject(new StepUpRequired('needs a passkey', 'enrol')),
    })
    expect(enrol).toMatchObject({ ok: false, message: expect.stringMatching(/Add your passkey first/) })
    const ended = await allowWithPasskey('sk_1', {
      supported: () => true,
      signIn,
      confirm: () => Promise.reject(new Error('That setup link is not your working one')),
    })
    expect(ended).toMatchObject({ ok: false, message: 'That setup link is not your working one' })
  })
})
