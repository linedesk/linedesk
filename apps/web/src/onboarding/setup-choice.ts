// Setting up by hand instead of with an AI agent (AgentSetup.tsx): the choice belongs to the admin on this install,
// not to the browser (LIN-181). It is kept on the server with the install progress (`setup.install`, manualBy), so a
// new install, or another admin of the same one, starts on the agent setup page again. The browser's old
// `linedesk.setup.manual` is ignored: it outlived the install it was made on.
import { AGENT_SETUP_HASH } from '@linedesk/actions'
import { runAdmin } from '../admin/api.ts'
import type { Me } from '../auth.ts'
import { readStored, storedFlag, writeStored } from '../safeStorage.ts'

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

// A workspace owner who is no server admin (2026-11-15): their onboarding starts with the AI agent too, with a setup
// link for their one workspace (agentSetup.createWorkspaceKey); setting up by hand leads into the step-by-step
// onboarding. Their choice is kept per workspace in this browser: the server keeps nothing for it, and a new browser
// simply offers the agent first again (one click to go by hand).
const ownerByHand = storedFlag('linedesk.ownerSetup.byHand.')

/** Whether this owner chose to set up this workspace by hand: in this tab just now, or before in this browser. */
export const ownerChoseByHand = (workspaceId: string, here: boolean): boolean => here || ownerByHand.on(workspaceId)

/** Remembers (or forgets, `on` false: back to the agent) the owner's choice for this workspace in this browser. */
export const rememberOwnerByHand = (workspaceId: string, on: boolean) => ownerByHand.set(workspaceId, on)

/**
 * Whether the owner's agent setup page shows instead of the app: for the workspace's owner (only the owner, one per
 * workspace; admins of it keep the step-by-step onboarding), signed in as themselves, with a confirmed address (making
 * the link needs one, like an API key), in a workspace that is not disabled; never for a server admin, who has the
 * install's own agent setup. A sign-up waiting for its trial gets it first too (agent-first, 2026-11-18): the agent does
 * the free steps, the owner starts the trial on the page; only a workspace whose setup was done
 * before (`onlyCard`: it left its partner) goes straight to the card by hand. It opens on #setup-agent, and on its own
 * while onboarding is open unless they chose by hand.
 */
export function ownerAgentSetupDue(
  me: Pick<Me, 'role' | 'onboarding' | 'impersonation' | 'emailUnconfirmed' | 'workspace'>,
  { instanceAdmin, hashOpen, byHand }: { instanceAdmin: boolean; hashOpen: boolean; byHand: boolean },
): boolean {
  if (instanceAdmin || me.role !== 'owner' || me.impersonation || me.emailUnconfirmed || me.workspace?.disabled)
    return false
  if (me.workspace?.billingState === 'pending_payment' && me.onboarding?.onlyCard) return false
  return hashOpen || (Boolean(me.onboarding) && !byHand)
}

/**
 * How the answer to a setup's Checkout (CheckoutReturn.tsx) shows for a business owner. Inside the setup while the
 * workspace waited for it (`inSetup`), as the Start trial step's result; in the shell it was started from: the agent
 * page's (`'agent'`) when the owner did not choose by hand, else the by-hand steps'. `planOnly`: no free trial for this
 * bill, so the step was "Start your plan".
 */
export function checkoutReturnSetup(
  me: Pick<Me, 'role' | 'onboarding' | 'impersonation' | 'emailUnconfirmed' | 'workspace'> | null,
  { instanceAdmin, byHand }: { instanceAdmin: boolean; byHand: boolean },
): { inSetup: boolean; shell: 'steps' | 'agent'; planOnly: boolean } {
  const viaAgent = !!me && ownerAgentSetupDue(me, { instanceAdmin, hashOpen: false, byHand })
  return {
    inSetup: !!me?.onboarding && me.workspace?.billingState === 'pending_payment',
    shell: viaAgent ? 'agent' : 'steps',
    planOnly: me?.workspace?.activation?.trialDays === null,
  }
}

// A white-label partner's owner (2026-11-18): after the partner Checkout their setup starts with the AI agent too
// (#partner/agent, a setup link for the partner and its client workspaces); "Set up by hand" opens the partner area and
// is kept per partner in this browser, as a workspace owner's choice is.
export const PARTNER_AGENT_HASH = '#partner/agent'
/**
 * The owner's guided setup by hand (PartnerSetup.tsx): their agency's brand, the first client workspace and White-label
 * Cloud's Checkout, one full-screen step at a time; `#partner/setup/<step>` opens a step.
 */
export const PARTNER_SETUP_HASH = '#partner/setup'
const partnerByHand = storedFlag('linedesk.partnerSetup.byHand.')

/**
 * White-label Cloud's one Activate screen (PartnerSetup.tsx, its last step; Janik, 2026-11-18): the agent page's
 * Activate row, the partner area's Activate line and the by-hand steps all open it. Back returns to where it was
 * opened from, kept for this tab (`openPartnerActivate`); without one, to the by-hand Clients step.
 */
export const PARTNER_ACTIVATE_HASH = `${PARTNER_SETUP_HASH}/activate`
export const PARTNER_CLIENTS_HASH = `${PARTNER_SETUP_HASH}/clients`
const ACTIVATE_FROM = 'linedesk.partnerSetup.activateFrom'

/** Opens the Activate step from the agent page (`#partner/agent`) or the partner area (`#partner`). */
export function openPartnerActivate(from: typeof PARTNER_AGENT_HASH | '#partner' | null) {
  writeStored('session', ACTIVATE_FROM, from)
  window.location.hash = PARTNER_ACTIVATE_HASH
}

/** Where the Activate step's Back leads: the page it was opened from, else the by-hand Clients step. */
export function partnerActivateBack(): string {
  const from = readStored('session', ACTIVATE_FROM)
  return from === PARTNER_AGENT_HASH || from === '#partner' ? from : PARTNER_CLIENTS_HASH
}

/** Whether this partner's owner chose the partner area by hand in this browser. */
export const partnerChoseByHand = (partnerId: string): boolean => partnerByHand.on(partnerId)

/** Remembers (or forgets, `on` false: back to the agent) the owner's choice for this partner in this browser. */
export const rememberPartnerByHand = (partnerId: string, on: boolean) => partnerByHand.set(partnerId, on)

/** Where the partner's owner lands after the partner Checkout: the agent setup, unless they chose by hand here. */
export const partnerLanding = (partnerId: string | null) =>
  partnerId && !partnerChoseByHand(partnerId) ? PARTNER_AGENT_HASH : '#partner'

/**
 * Which agent setup page someone setting up by hand can go back to (2026-11-18): every step of the step-by-step setup
 * offers it in its top bar ("Set up with AI"), for the people the page itself is for. An instance admin: the
 * install's page (#setup-agent). A workspace owner: their workspace's page, by the same rules that open it on its own
 * (`ownerAgentSetupDue`). The owner of the white-label partner whose client workspace this is: the partner's page
 * (#partner/agent), as from the partner area's top bar. Nobody while impersonating.
 */
export type AgentSetupWayBack = 'install' | 'owner' | 'partner' | null

export function agentSetupWayBack(
  me: Pick<Me, 'role' | 'onboarding' | 'impersonation' | 'emailUnconfirmed' | 'workspace' | 'partners'>,
  { instanceAdmin }: { instanceAdmin: boolean },
): AgentSetupWayBack {
  if (me.impersonation) return null
  if (instanceAdmin) return 'install'
  if (ownerAgentSetupDue(me, { instanceAdmin, hashOpen: true, byHand: true })) return 'owner'
  const partner = me.partners?.[0]
  if (me.workspace?.viaPartner && partner?.role === 'owner' && partner.status !== 'suspended') return 'partner'
  return null
}

/**
 * Goes back to that agent setup page and forgets the choice to go by hand, where it is kept: on the server for an
 * instance admin, in this browser for this workspace's or this partner's owner. Nothing else changes: the page goes on
 * from what is saved.
 */
export function backToAgentSetup(way: Exclude<AgentSetupWayBack, null>, me: Pick<Me, 'workspace' | 'partners'>): void {
  if (way === 'install') backToInstallAgent()
  else if (way === 'owner') {
    if (me.workspace) rememberOwnerByHand(me.workspace.id, false)
    window.location.hash = AGENT_SETUP_HASH
  } else if (me.partners?.[0]) backToPartnerAgent(me.partners[0].id)
}

/** The install's agent setup page, the choice to go by hand forgotten (every way back to it goes through here). */
export function backToInstallAgent(): void {
  rememberManual(false)
  window.location.hash = AGENT_SETUP_HASH
}

/** The partner's agent setup page, the owner's choice to go by hand forgotten (every way back to it goes through here). */
export function backToPartnerAgent(partnerId: string): void {
  rememberPartnerByHand(partnerId, false)
  window.location.hash = PARTNER_AGENT_HASH
}
