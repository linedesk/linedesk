// The passkey screen of the install setup by hand (InstallSetup.tsx, LIN-189): email and sign-in keys need the admin's
// passkey (apps/api/src/admin-step-up.ts), so an admin without one adds it before the Email step.
import type { InstallSetupState, InstallStep } from '@linedesk/actions'

/** Whether the passkey screen comes before `step`: only before Email, while the admin has none and has not skipped it. */
export function showPasskeyFirst(
  step: InstallStep | null,
  setup: Pick<InstallSetupState, 'passkeyNeeded'> | null,
  skipped: boolean,
): boolean {
  return step === 'email' && setup?.passkeyNeeded === true && !skipped
}
