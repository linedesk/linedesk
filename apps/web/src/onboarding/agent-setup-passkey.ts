// The admin's passkey on the agent setup page (AgentSetup.tsx): step 1, before the setup link, because an agent can
// never add one (it needs the admin's device). Done means what the setup MCP's `passkey` step says (setup-mcp.ts,
// passkeyStep: the admin has a passkey), or that it was just added here (shown at once, before the next read).
import type { AgentSetupState } from '@linedesk/actions'

/**
 * `loading`: not known yet. `none`: this install asks admins for no passkey, so the page has no passkey step.
 * `todo` / `done`: whether the admin has one.
 */
export type PasskeyStep = 'loading' | 'none' | 'todo' | 'done'

export function passkeyStepOf(state: Pick<AgentSetupState, 'progress'> | null, addedHere: boolean): PasskeyStep {
  if (addedHere) return 'done'
  if (!state) return 'loading'
  const step = state.progress.steps.find(s => s.id === 'passkey')
  if (!step) return 'none'
  return step.state === 'done' ? 'done' : 'todo'
}

/** The progress with the passkey row done as soon as it was added here (the server says so on its next read). */
export function withPasskeyAdded<S extends { id: string; state: string }>(
  steps: readonly S[],
  addedHere: boolean,
): S[] {
  return addedHere ? steps.map(s => (s.id === 'passkey' ? ({ ...s, state: 'done' } as S) : s)) : [...steps]
}

/** The install's own steps (setup-mcp.ts, the provider groups): by hand, the install walkthrough does them first. */
const INSTALL_STEPS = ['answering', 'telephony', 'email', 'call-audio']

/** Whether a server part is not set up yet, so the way by hand starts with the install walkthrough. */
export const installPartsMissing = (steps: readonly { id: string; state: string }[]) =>
  steps.some(s => INSTALL_STEPS.includes(s.id) && s.state !== 'done')
