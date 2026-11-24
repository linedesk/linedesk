// The browser's own passkey suggestion in the sign-in page's email field (WebAuthn conditional mediation, LIN-215).
// It and the "Sign in with passkey" button share one challenge cookie, so the button stops it first (`stop`): its
// challenge request is aborted and its ceremony cancelled, and a late answer can no longer replace the button's
// challenge. Only where the browser offers the suggestion is a challenge asked for at all.
import {
  type AuthenticationResponseJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  startAuthentication,
  WebAuthnAbortService,
} from '@simplewebauthn/browser'
import { auth } from './auth.ts'

type Answer<T> = { data: T | null; error: unknown }

export type AutofillDeps = {
  /** Whether this browser offers passkeys in an input's autofill (conditional mediation). */
  available: () => Promise<boolean>
  challenge: (signal: AbortSignal) => Promise<Answer<PublicKeyCredentialRequestOptionsJSON>>
  /** Waits until a passkey is picked in the field; rejects when cancelled. */
  pick: (options: PublicKeyCredentialRequestOptionsJSON) => Promise<AuthenticationResponseJSON>
  verify: (response: AuthenticationResponseJSON) => Promise<Answer<unknown>>
  cancelCeremony: () => void
}

/** `offer` resolves true once a passkey picked in the field signed in; false when stopped, refused or not offered. */
export function passkeyAutofill(deps: AutofillDeps) {
  let current: AbortController | null = null

  function stop() {
    if (!current) return
    current.abort()
    current = null
    deps.cancelCeremony()
  }

  async function offer(): Promise<boolean> {
    stop()
    const controller = new AbortController()
    current = controller
    const live = () => !controller.signal.aborted
    try {
      if (!(await deps.available()) || !live()) return false
      const options = await deps.challenge(controller.signal)
      if (!options.data || options.error || !live()) return false
      const response = await deps.pick(options.data)
      if (!live()) return false
      const verified = await deps.verify(response)
      return Boolean(verified.data) && !verified.error
    } catch {
      // Cancelled, aborted, or the browser refused: nothing to show, the page has the other ways in.
      return false
    } finally {
      if (current === controller) current = null
    }
  }

  return { offer, stop }
}

const conditionalMediation = async () => {
  const credential = typeof window === 'undefined' ? undefined : window.PublicKeyCredential
  return Boolean(await credential?.isConditionalMediationAvailable?.().catch(() => false))
}

/** The one for the sign-in page, on Better Auth's passkey endpoints (the same ones the button uses). */
export const emailFieldPasskey = passkeyAutofill({
  available: conditionalMediation,
  challenge: signal =>
    auth.$fetch<PublicKeyCredentialRequestOptionsJSON>('/passkey/generate-authenticate-options', {
      method: 'GET',
      signal,
    }) as Promise<Answer<PublicKeyCredentialRequestOptionsJSON>>,
  pick: optionsJSON => startAuthentication({ optionsJSON, useBrowserAutofill: true }),
  // As Better Auth's own client sends it: without the extension results.
  verify: ({ clientExtensionResults: _, ...response }) =>
    auth.$fetch('/passkey/verify-authentication', { method: 'POST', body: { response } }) as Promise<Answer<unknown>>,
  cancelCeremony: () => WebAuthnAbortService.cancelCeremony(),
})
