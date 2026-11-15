// The admin's passkey on the setup pages by hand (InstallSetup.tsx) and the install's own steps. The agent setup page
// has no passkey step: it is part of Server admin and opens only after the passkey check (SecondFactorPrompt.tsx).

/**
 * `loading`: not known yet. `none`: no passkey step (the admin has one, or this install asks admins for none).
 * `todo` / `done`: whether the admin has one.
 */
export type PasskeyStep = 'loading' | 'none' | 'todo' | 'done'

/** The install's own steps (setup-mcp.ts, the provider groups): by hand, the install walkthrough does them first. */
const INSTALL_STEPS = ['answering', 'telephony', 'email', 'call-audio']

/** Whether a server part is not set up yet, so the way by hand starts with the install walkthrough. */
export const installPartsMissing = (steps: readonly { id: string; state: string }[]) =>
  steps.some(s => INSTALL_STEPS.includes(s.id) && s.state !== 'done')
