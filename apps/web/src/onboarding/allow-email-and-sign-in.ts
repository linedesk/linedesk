// "Allow with passkey" on the agent setup page (AgentSetup.tsx): the admin's passkey first, every time, then the grant
// (agentSetup.confirmPasskey). The server takes it only right after a passkey sign-in (admin-step-up.ts,
// FRESH_PASSKEY_MINUTES), so the passkey is the consent to this one link, never a sign-in from hours ago.
//
// Why not runAdmin: its step-up dialog (PasskeyStepUpHost) is mounted in the admin area and the app, not on this page.
// Without it the step-up refusal was thrown on without any passkey prompt, and Allow ended as a red line under the card.
import { StepUpRequired } from '../admin/PasskeyStepUp.tsx'
import { authErrorMessage, PASSKEY_CANCELLED } from '../sign-in-code.ts'

export type AllowResult =
  | { ok: true; until: string | null }
  /** `cancelled`: the admin closed the passkey prompt; said calmly, the dialog stays for another try. */
  | { ok: false; message: string; cancelled: boolean }

export type AllowSteps = {
  /** Whether this browser can use a passkey here (https or localhost). */
  supported: () => boolean
  /** The passkey sign-in (auth.ts signInWithPasskey): Better Auth answers `{ error }` instead of throwing. */
  signIn: () => Promise<{ error?: unknown; data?: unknown } | null | undefined>
  /** agentSetup.confirmPasskey once, without the admin area's step-up dialog (api.ts runAdminOnce). */
  confirm: (keyId: string) => Promise<Record<string, unknown>>
}

const CANCELLED = authErrorMessage({ code: PASSKEY_CANCELLED })
export const PASSKEYS_NEED_HTTPS = 'Passkeys need https. Open this page at its https address (or on localhost).'

/**
 * The browser's passkey prompt ended without a passkey (closed, timed out, the device did not confirm): Better Auth
 * passes the WebAuthn error's own code (ERROR_…), not AUTH_CANCELLED. Nothing reached the server; another try may work.
 */
const promptClosed = (error: unknown) => {
  const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined
  return typeof code === 'string' && code.startsWith('ERROR_')
}

export async function allowWithPasskey(keyId: string, steps: AllowSteps): Promise<AllowResult> {
  if (!steps.supported()) return { ok: false, message: PASSKEYS_NEED_HTTPS, cancelled: false }
  const signedIn = await steps.signIn().catch((error: unknown) => ({ error }))
  if (signedIn?.error) {
    const message = authErrorMessage(signedIn.error)
    return { ok: false, message, cancelled: message === CANCELLED || promptClosed(signedIn.error) }
  }
  try {
    const data = await steps.confirm(keyId)
    return { ok: true, until: typeof data.emailAndSignInUntil === 'string' ? data.emailAndSignInUntil : null }
  } catch (e) {
    if (e instanceof StepUpRequired)
      return {
        ok: false,
        cancelled: false,
        message:
          e.stepUp === 'enrol'
            ? 'Add your passkey first (step 1 on this page), then allow. Nothing was allowed.'
            : 'Your passkey sign-in did not count for this. Try again. Nothing was allowed.',
      }
    return { ok: false, cancelled: false, message: e instanceof Error ? e.message : 'Could not allow it. Try again.' }
  }
}
