// Setting up by hand instead of with an AI agent (AgentSetup.tsx): the choice belongs to the admin on this install,
// not to the browser (LIN-181). It is kept on the server with the install progress (`setup.install`, manualBy), so a
// new install, or another admin of the same one, starts on the agent setup page again. The browser's old
// `linedesk.setup.manual` is ignored: it outlived the install it was made on.
import { runAdmin } from '../admin/api.ts'
import type { Me } from '../auth.ts'

/**
 * Whether this admin sets up by hand: chosen on this install (`me.setupByHand`, from the server), or just now in this
 * tab (before /v1/me is read again). The agent setup page still opens with #setup-agent.
 */
export function choseManualSetup(me: Pick<Me, 'setupByHand'> | null | undefined, here: boolean): boolean {
  return here || Boolean(me?.setupByHand)
}

/** Remembers the choice for this admin on this install; leaving the install walkthrough counts as the manual way too. */
export function rememberManual(on: boolean) {
  runAdmin('install.setProgress', { manual: on }).catch(() => {
    // Not saved (offline, signed out): the choice lasts this page only.
  })
}
