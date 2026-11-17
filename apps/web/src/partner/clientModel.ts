// What Partner › Clients shows for one client, kept out of the components so it can be tested: the tone of each
// problem and of the usage bar, who else is in the workspace (without its owner, who has a line of their own), and
// which of the less frequent actions a row's "…" menu offers.
import type { ClientProblem, PartnerClient, PartnerClientRow } from '@linedesk/actions'

/** Problems that stop calls or money: red. The rest are warnings: amber. */
const BLOCKING: ReadonlySet<ClientProblem> = new Set(['bill_inactive', 'disabled', 'limit_reached', 'forwarding_failed'])

export const problemTone = (problem: ClientProblem): 'danger' | 'warning' =>
  BLOCKING.has(problem) ? 'danger' : 'warning'

/** Near its limit (80 %) is a warning, at or over it blocks new calls; below that the bar stays ink. */
export function usageTone(percent: number | null): 'danger' | 'warning' | null {
  if (percent === null) return null
  if (percent >= 100) return 'danger'
  if (percent >= 80) return 'warning'
  return null
}

/** How much of the bar is filled: 0 to 100, also for a client over its limit. */
export const barWidth = (percent: number) => Math.max(0, Math.min(100, percent))

/** Whether the client used nothing this period: the usage column shows a dash instead of "$0.00" and "0 calls". */
export const usedNothing = (row: Pick<PartnerClientRow, 'calls' | 'seconds' | 'costCents'>) =>
  row.calls === 0 && row.seconds === 0 && !row.costCents

/**
 * The people in a client workspace who are not on the partner team, without its owner: the owner has the row's own
 * line, so "Also in it" never names them twice.
 */
export const othersThanOwner = (client: Pick<PartnerClient, 'otherMembers'> | undefined) =>
  (client?.otherMembers ?? []).filter(m => m.role !== 'owner')

export type ClientAction = 'settings' | 'inviteOwner' | 'ownerInvitation' | 'release'

/**
 * The row's "…" menu, in this order: Settings (limit and Premium; on the partner bill only), then, for the partner's
 * owner, what the client's owner needs next: invite one, see the open invitation (resend or withdraw it on the
 * client's Team page), or hand the workspace over to them.
 */
export function clientActions(row: Pick<PartnerClientRow, 'billed'>, client: PartnerClient | undefined, owner: boolean) {
  const actions: { id: ClientAction; enabled: boolean }[] = [{ id: 'settings', enabled: row.billed }]
  if (!owner || !client) return actions
  if (client.owner === null) actions.push({ id: 'inviteOwner', enabled: true })
  else if ('invited' in client.owner) actions.push({ id: 'ownerInvitation', enabled: true })
  else actions.push({ id: 'release', enabled: true })
  return actions
}
