// A white-label partner owner's agent setup (#partner/agent, 2026-11-18): after the partner Checkout the owner lands
// here first. An AI agent sets up the partner (company, brand, team) and its client workspaces with a setup link for
// this partner only (agentSetup.createPartnerKey); the owner adds client workspaces (a seat on the bill), numbers,
// call forwarding and test calls on the page's rows. "Set up by hand instead" opens the guided setup (#partner/setup,
// PartnerSetup.tsx) and is remembered.
import type { MyPartner } from '@linedesk/actions'
import { AgentSetup } from '../onboarding/AgentSetup.tsx'
import { PARTNER_SETUP_HASH, rememberPartnerByHand } from '../onboarding/setup-choice.ts'

export function PartnerAgentSetup({
  partner,
  active,
  onFirstWorkspace,
}: {
  partner: MyPartner
  /** The tab's workspace, when there is one: a client workspace's forwarding and test call run in it. */
  active?: { id: string; account: string }
  /** The first client workspace was made while in no workspace: the session loads again (NoWorkspace). */
  onFirstWorkspace?: () => void
}) {
  return (
    <AgentSetup
      scope="partner"
      partner={partner}
      active={active}
      onFirstWorkspace={onFirstWorkspace}
      onManual={() => {
        rememberPartnerByHand(partner.id, true)
        window.location.hash = PARTNER_SETUP_HASH
      }}
      onDone={() => {
        window.location.hash = '#partner'
      }}
    />
  )
}
