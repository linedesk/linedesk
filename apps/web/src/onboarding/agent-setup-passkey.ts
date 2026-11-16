// The install's own steps. The setup pages have no passkey step: they are part of Server admin and open only after
// the passkey check (SecondFactorPrompt.tsx).

/** The install's own steps (setup-mcp.ts, the provider groups): by hand, the install walkthrough does them first. */
const INSTALL_STEPS = ['answering', 'telephony', 'email', 'call-audio']

/** Whether a server part is not set up yet, so the way by hand starts with the install walkthrough. */
export const installPartsMissing = (steps: readonly { id: string; state: string }[]) =>
  steps.some(s => INSTALL_STEPS.includes(s.id) && s.state !== 'done')
