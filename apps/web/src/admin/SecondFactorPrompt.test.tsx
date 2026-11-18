import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test, vi } from 'vitest'

vi.mock('../auth.ts', async importOriginal => ({
  ...(await importOriginal<typeof import('../auth.ts')>()),
  passkeySupported: () => true,
  fetchMe: () => new Promise(() => {}),
}))
// The page frame follows the app's theme (a browser-only store): the card inside is what is tested.
vi.mock('../ui/kit.tsx', async importOriginal => ({
  ...(await importOriginal<typeof import('../ui/kit.tsx')>()),
  AuthPage: ({ children }: { children: React.ReactNode }) => children,
}))
vi.mock('../enrolment-code.ts', () => ({ readEnrolmentCode: () => null }))

const { ADMIN_PASSKEY_HOURS, enrolmentCommand, passkeyNotVerifiedForAdmin, SECOND_FACTOR_BUTTON, SecondFactorPrompt } =
  await import('./SecondFactorPrompt.tsx')

const noop = () => {}

describe('the passkey check before Server admin', () => {
  test('confirm: one passkey button, valid 12 hours, workspaces work without it; no other way in', () => {
    const html = renderToStaticMarkup(<SecondFactorPrompt state="confirm" onExit={noop} />)
    expect(ADMIN_PASSKEY_HOURS).toBe(12)
    expect(html).toContain('Confirm with your passkey')
    expect(html).toContain('counts for 12 hours in this browser')
    expect(html).toContain('Your workspaces work without it.')
    expect(html).toContain('Confirm with passkey')
    expect(html).not.toMatch(/email code|password|Google|Sign in again/i)
  })

  test('ending agent access is offered without the passkey: taking access away is never harder than granting it', () => {
    for (const state of ['confirm', 'enrol'] as const)
      expect(renderToStaticMarkup(<SecondFactorPrompt state={state} onExit={noop} />)).toContain('End agent access')
  })

  test('a passkey sign-in the device did not verify says why it does not open Server admin', () => {
    expect(passkeyNotVerifiedForAdmin()).toBe(
      "This passkey doesn't check your fingerprint, face or PIN, so it can't open Server admin. Use one that does, or ask another admin to reset your passkeys (on the server: user-passkeys.ts --remove).",
    )
  })

  test('enrol: the enrollment code and where to get it, the CLI included', () => {
    const html = renderToStaticMarkup(<SecondFactorPrompt state="enrol" onExit={noop} />)
    expect(html).toContain('Add a passkey for Server admin')
    expect(html).toContain('Enrollment code')
    expect(html).toContain(enrolmentCommand().replace('<', '&lt;').replace('>', '&gt;'))
    expect(enrolmentCommand()).toMatch(/user-passkeys\.ts --enrol --email <your email>$/)
    expect(html).toContain('Add passkey')
    expect(html).not.toContain('Confirm with passkey')
  })

  test('the buttons that open the prompt from elsewhere name the next step', () => {
    expect(SECOND_FACTOR_BUTTON.email).toBe('Confirm your email first')
    expect(SECOND_FACTOR_BUTTON.enrol).toBe('Add a passkey')
    expect(SECOND_FACTOR_BUTTON.confirm).toBe('Confirm with your passkey')
  })
})
