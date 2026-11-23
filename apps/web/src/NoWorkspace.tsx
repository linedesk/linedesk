// Signed in, but a member of no workspace: a new account not added to one yet, skipped an invitation ("Not now"), or
// removed from the last one. What they can do here:
// - join a workspace they are invited to (a skipped invitation stays here until it is answered), or a partner team
//   whose invitation they left before Join (it is listed here too, joined in place; LIN-776);
// - name their own business, if they are a server admin (only server admins create workspaces; self-serve creation
//   comes with billing), after the passkey check; everyone else waits for a server admin to add them;
// - open Account settings, which need no workspace, or sign out (the account menu; "Use a different account" while
//   waiting to be added);
// - a server admin opens Server admin, which needs no workspace. Right after setting up the server they land on
//   "Name your business" too (the first workspace), with Server admin one click away; once they have a workspace, /
//   opens it.

import type { MyPartnerInvitation } from '@linedesk/actions'
import { T, useT } from '@linedesk/i18n/react'
import { type ReactNode, useEffect, useState } from 'react'
import { AdminMode } from './admin/AdminMode.tsx'
import { SecondFactorPrompt } from './admin/SecondFactorPrompt.tsx'
import { auth, isInstanceAdmin, type Me } from './auth.ts'
import { i18n } from './i18n/index.tsx'
import { signOutAndForget } from './localData.ts'
import { AdminStart } from './onboarding/AdminStart.tsx'
import { AgentSetup, choseManualSetup, isAgentSetupHash, rememberManual } from './onboarding/AgentSetup.tsx'
import { INSTALL_SETUP_HASH, InstallSetup } from './onboarding/InstallSetup.tsx'
import { backToInstallAgent, PARTNER_AGENT_HASH } from './onboarding/setup-choice.ts'
import { PartnerAgentSetup } from './partner/PartnerAgentSetup.tsx'
import { PartnerArea } from './partner/PartnerArea.tsx'
import { partnerErrorText, refreshMyPartners } from './partner/partner-api.ts'
import { deletedOnPurpose, leftOnPurpose } from './session.ts'
import { AccountSettings } from './settings/account/index.tsx'
import { callAction } from './settings/settings-api.ts'
import { roleLabel } from './shell/invitations.ts'
import { SignedInAuthPage } from './shell/SignedInAuthPage.tsx'
import { AuthError } from './ui/AuthError.tsx'

export type PendingInvitation = { id: string; workspaceName: string; role: string }
type InvitationRow = { id: string; organizationName?: string; role: string; status: string; expiresAt: string | Date }

/** Invitations that can still be answered: pending and not expired. */
export function pendingInvitations(rows: InvitationRow[], now = new Date()): PendingInvitation[] {
  return rows
    .filter(r => r.status === 'pending' && new Date(r.expiresAt).getTime() > now.getTime())
    .map(r => ({
      id: r.id,
      workspaceName: r.organizationName || i18n().t('auth.noWorkspace.aWorkspace'),
      role: r.role,
    }))
}

async function loadInvitations(): Promise<PendingInvitation[]> {
  const res = await auth.organization.listUserInvitations()
  return res.error ? [] : pendingInvitations((res.data ?? []) as InvitationRow[])
}

/** The open partner team invitations to this address (`partnerInvitation.listMine`); none when they cannot be read. */
async function loadPartnerInvitations(): Promise<MyPartnerInvitation[]> {
  try {
    return (await callAction<{ invitations: MyPartnerInvitation[] }>('partnerInvitation.listMine', {})).invitations
  } catch {
    return []
  }
}

/**
 * May this person name their own business here? Only a server admin (self-serve creation comes with billing, postponed)
 * whose session passed the passkey check: before it, POST /v1/workspaces answers 403 `admin_second_factor`, so the form
 * and "New workspace…" are not offered yet. The server checks it too.
 */
export const mayCreateWorkspace = (me: Me | null) => !!me && isInstanceAdmin(me) && !me.adminSecondFactor

/**
 * What "New workspace…" in the workspace menu does for this person: a server admin's New workspace dialog (`admin`); a
 * Cloud customer's own sign-up without the email step (`signup`, a new bill of its own, the trial once per account),
 * or the sign-up still waiting for Checkout (`finish`: one at a time); null: not offered (also
 * on a partner team, in a partner's client workspace or while signed in as someone else). The server decides who is a
 * Cloud customer (`me.newWorkspace`) and checks it all again.
 */
export type NewWorkspaceChoice =
  | { kind: 'admin' }
  | { kind: 'signup'; interval: 'month' | 'year'; trial: boolean }
  | { kind: 'finish'; workspace: { id: string; name: string } }

export function newWorkspaceChoice(me: Me | null): NewWorkspaceChoice | null {
  if (!me) return null
  if (mayCreateWorkspace(me)) return { kind: 'admin' }
  const offer = me.newWorkspace
  if (!offer || me.impersonation || me.workspace?.partnerManaged || me.partners?.length) return null
  if (offer.waiting) return offer.waiting.id === me.workspace?.id ? null : { kind: 'finish', workspace: offer.waiting }
  return { kind: 'signup', interval: offer.interval, trial: offer.trial }
}

type Props = {
  /** null when /v1/me did not answer for this person (no workspace and no instance admin). */
  me: Me | null
  /** The workspace this person was just removed from (this browser had it open): said first. */
  lostWorkspace?: string | null
  onDone: () => void
  /** Opens an invitation (the same page an invitation link shows: Join or Not now). */
  onOpenInvite: (invitationId: string) => void
}

export function NoWorkspace({ me, lostWorkspace = null, onDone, onOpenInvite }: Props) {
  const t = useT()
  const admin = Boolean(me && isInstanceAdmin(me))
  const hash = useHash()
  const [invitations, setInvitations] = useState<PendingInvitation[] | null>(null)
  // A new install: its first admin sets it up with an AI agent first, unless they chose to do it by hand.
  const [manualSetup, setManualSetup] = useState(false)
  // The install walkthrough was left in this tab (finished or set aside): by hand goes on to naming the business.
  const [installLeft, setInstallLeft] = useState(false)
  const [partnerInvitations, setPartnerInvitations] = useState<MyPartnerInvitation[] | null>(null)
  useEffect(() => {
    void loadInvitations().then(setInvitations)
    void loadPartnerInvitations().then(setPartnerInvitations)
  }, [])
  const leave = () => {
    window.location.hash = '#start'
  }
  // Account settings need no workspace (an admin without one manages sign-in methods there). Being signed in is
  // enough: `me` is null for someone in no workspace who is no instance admin, and they have an account all the same.
  if (hash.startsWith('#account')) return <AccountPage onBack={leave} />
  // On a white-label partner's team: the partner area is their place until they open a client workspace.
  const partner = me?.partners?.[0]
  if (partner && hash === PARTNER_AGENT_HASH && partner.role === 'owner' && !me?.impersonation)
    return <PartnerAgentSetup partner={partner} onFirstWorkspace={onDone} />
  if (partner && !hash.startsWith('#admin') && !me?.impersonation)
    return <PartnerArea partner={partner} onFirstWorkspace={onDone} />
  if (me && admin && hash.startsWith('#admin')) {
    if (me.adminSecondFactor) return <SecondFactorPrompt state={me.adminSecondFactor} onExit={leave} />
    return <AdminMode currentUserId={me.actorId} onExit={leave} />
  }
  if (me && admin && !me.impersonation && hash === INSTALL_SETUP_HASH) {
    if (me.adminSecondFactor) return <SecondFactorPrompt state={me.adminSecondFactor} onExit={leave} />
    return (
      <InstallSetup
        // "Set up with AI" on its steps: back to the agent setup page, which goes on from what is saved.
        onAgentSetup={() => {
          setManualSetup(false)
          backToInstallAgent()
        }}
        onExit={() => {
          // Opened by its link or from Server admin › Overview: leaving it goes on to naming the business, not the
          // agent page.
          rememberManual(true)
          setManualSetup(true)
          setInstallLeft(true)
          leave()
        }}
      />
    )
  }
  if (me && admin && !me.impersonation && (isAgentSetupHash(hash) || !choseManualSetup(me, manualSetup))) {
    // The setup page is part of Server admin: the passkey check first. Back goes on by hand (naming the business, which
    // also waits for the passkey check).
    if (me.adminSecondFactor)
      return (
        <SecondFactorPrompt
          state={me.adminSecondFactor}
          onExit={() => {
            rememberManual(true)
            setManualSetup(true)
            if (isAgentSetupHash(hash)) leave()
          }}
        />
      )
    return (
      <AgentSetup
        onManual={installFirst => {
          setManualSetup(true)
          // The install by hand, step by step; leaving it goes on to naming the business.
          if (installFirst) window.location.hash = INSTALL_SETUP_HASH
          else if (isAgentSetupHash(hash)) leave()
        }}
        onDone={() => {
          if (isAgentSetupHash(hash)) leave()
          onDone()
        }}
        // Finish later, as on the owner's and the partner's agent pages: on by hand, from the start page.
        onLater={() => {
          rememberManual(true)
          setManualSetup(true)
          leave()
        }}
        onWorkspaceReady={onDone}
      />
    )
  }
  if (invitations === null || partnerInvitations === null) return <SignedInAuthPage>{null}</SignedInAuthPage>
  const invited = invitations.length + partnerInvitations.length > 0

  const extras = (
    <>
      {invitations.length > 0 && <InvitationList invitations={invitations} onOpen={onOpenInvite} />}
      {partnerInvitations.length > 0 && (
        <PartnerInvitationList
          invitations={partnerInvitations}
          onJoined={() => {
            window.location.hash = '#partner'
            onDone()
          }}
        />
      )}
      {admin && (
        <button
          type="button"
          className="k-btn k-btn-secondary"
          onClick={() => (window.location.hash = '#admin')}
          title={t('auth.noWorkspace.adminTip')}
        >
          {t('auth.noWorkspace.openAdmin')}
        </button>
      )}
      <button
        type="button"
        className="auth-switch"
        onClick={() => (window.location.hash = '#account')}
        title={t('auth.noWorkspace.accountTip')}
      >
        {t('shell.page.account')}
      </button>
    </>
  )
  // An instance admin (also one who chose the way by hand before): the AI agent first, by hand as the alternative.
  if (me && admin && !me.impersonation)
    return (
      <AdminStart
        onDone={onDone}
        lostWorkspace={lostWorkspace}
        byHandFirst={choseManualSetup(me, manualSetup)}
        secondFactor={me.adminSecondFactor ?? null}
        installLeft={installLeft}
        onInstallByHand={() => {
          rememberManual(true)
          window.location.hash = INSTALL_SETUP_HASH
        }}
      >
        {extras}
      </AdminStart>
    )
  return (
    <NoWorkspaceYet
      onDone={onDone}
      lostWorkspace={lostWorkspace}
      hasInvitations={invited}
      onlyPartner={invitations.length === 0 && partnerInvitations.length > 0}
    >
      {extras}
    </NoWorkspaceYet>
  )
}

/** The address bar's hash, kept up to date. */
function useHash() {
  const [hash, setHash] = useState(() => window.location.hash)
  useEffect(() => {
    const onChange = () => setHash(window.location.hash)
    window.addEventListener('hashchange', onChange)
    return () => window.removeEventListener('hashchange', onChange)
  }, [])
  return hash
}

/** Account settings on their own, for someone without a workspace (no inbox around them). */
function AccountPage({ onBack }: { onBack: () => void }) {
  const t = useT()
  return (
    <div className="page">
      <div className="pagebar">
        <button type="button" className="k-btn k-btn-ghost k-btn-sm" onClick={onBack} title={t('auth.back')}>
          {t('auth.back')}
        </button>
        <b>{t('auth.noWorkspace.account')}</b>
      </div>
      <AccountSettings hasWorkspace={false} />
    </div>
  )
}

function InvitationList({ invitations, onOpen }: { invitations: PendingInvitation[]; onOpen: (id: string) => void }) {
  const t = useT()
  return (
    <div className="auth-invites" role="group" aria-label={t('shell.switcher.invitations')}>
      {invitations.map(i => (
        <div key={i.id} className="auth-invite">
          <span>
            <T
              k="auth.noWorkspace.invited"
              values={{ workspace: i.workspaceName, role: roleLabel(i.role), b: chunks => <b>{chunks}</b> }}
            />
          </span>
          <button
            type="button"
            className="k-btn k-btn-primary k-btn-sm"
            onClick={() => onOpen(i.id)}
            title={t('auth.noWorkspace.openTip', { workspace: i.workspaceName })}
          >
            {t('auth.noWorkspace.open')}
          </button>
        </div>
      ))}
    </div>
  )
}

/**
 * Partner team invitations to this address, joined in place (`partnerInvitation.acceptMine`): someone who signed in
 * through the invitation's link and left it before Join (the passkey prompt, Not now) is not "waiting for an
 * invitation" (B5, LIN-776).
 */
export function PartnerInvitationList({
  invitations,
  onJoined,
}: {
  invitations: MyPartnerInvitation[]
  onJoined: () => void
}) {
  const t = useT()
  const [busy, setBusy] = useState<string | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  async function join(id: string) {
    setBusy(id)
    setProblem(null)
    try {
      await callAction('partnerInvitation.acceptMine', { invitationId: id })
      await refreshMyPartners()
      onJoined()
    } catch (err) {
      setProblem(partnerErrorText(err))
      setBusy(null)
    }
  }
  return (
    <div className="auth-invites" role="group" aria-label={t('auth.noWorkspace.partnerInvitations')}>
      {invitations.map(i => (
        <div key={i.id} className="auth-invite">
          <span>
            <T
              k="auth.noWorkspace.partnerInvited"
              values={{
                partner: i.partnerName,
                role: i.role,
                b: chunks => <b>{chunks}</b>,
              }}
            />
          </span>
          <button
            type="button"
            className="k-btn k-btn-primary k-btn-sm"
            disabled={busy !== null}
            aria-busy={busy === i.id || undefined}
            onClick={() => void join(i.id)}
            title={t('auth.noWorkspace.joinPartnerTip', { partner: i.partnerName })}
          >
            {t('team.partner.invite.join')}
          </button>
        </div>
      ))}
      {problem && <AuthError message={problem} />}
    </div>
  )
}

/** This person may not create a workspace (only server admins do): they wait for a server admin to add them. */
function NoWorkspaceYet({
  hasInvitations,
  onlyPartner = false,
  lostWorkspace,
  onDone,
  children,
}: {
  hasInvitations: boolean
  /** The invitations are partner teams' only: the line asks to join that, not a workspace. */
  onlyPartner?: boolean
  lostWorkspace: string | null
  onDone: () => void
  children: ReactNode
}) {
  const t = useT()
  return (
    <SignedInAuthPage>
      <div className="auth-card">
        <h1>
          {lostWorkspace
            ? deletedOnPurpose(lostWorkspace)
              ? t('auth.lost.deleted', { workspace: lostWorkspace })
              : leftOnPurpose(lostWorkspace)
                ? t('auth.lost.left', { workspace: lostWorkspace })
                : t('auth.lost.noAccess', { workspace: lostWorkspace })
            : hasInvitations
              ? t('auth.noWorkspace.invitedTitle')
              : t('auth.noWorkspace.waiting')}
        </h1>
        <p>
          {onlyPartner
            ? t('auth.noWorkspace.joinPartner')
            : hasInvitations
              ? t('auth.noWorkspace.joinOrAsk')
              : t('auth.noWorkspace.ask')}
        </p>
        {children}
        <button type="button" className="auth-switch" onClick={() => void signOutAndForget().then(onDone)}>
          {t('auth.differentAccount')}
        </button>
      </div>
    </SignedInAuthPage>
  )
}
