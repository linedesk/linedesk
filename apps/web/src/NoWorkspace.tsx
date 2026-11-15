// Signed in, but a member of no workspace: just signed up, skipped an invitation ("Not now"), or
// removed from the last one. What they can do here:
// - join a workspace they are invited to (a skipped invitation stays here until it is answered);
// - name their own business, if they are a server admin (only server admins create workspaces, also with sign-up
//   open; self-serve creation comes with billing); everyone else waits for a server admin to add them;
// - open Account settings, which need no workspace, or sign out ("Use a different account");
// - an instance admin opens Server admin, which needs no workspace. Right after setting up the server they land on
//   "Name your business" too (the first workspace), with Server admin one click away; once they have a workspace, /
//   opens it.
import { type ReactNode, useEffect, useState } from 'react'
import { AdminMode } from './admin/AdminMode.tsx'
import { SecondFactorPrompt } from './admin/SecondFactorPrompt.tsx'
import { auth, isInstanceAdmin, type Me } from './auth.ts'
import { AdminStart } from './onboarding/AdminStart.tsx'
import { AgentSetup, choseManualSetup, isAgentSetupHash, rememberManual } from './onboarding/AgentSetup.tsx'
import { INSTALL_SETUP_HASH, InstallSetup } from './onboarding/InstallSetup.tsx'
import { AccountSettings } from './settings/account/index.tsx'
import { signOutAndForget } from './localData.ts'
import { deletedOnPurpose, leftOnPurpose } from './session.ts'
import { AuthPage } from './ui/kit.tsx'

export type PendingInvitation = { id: string; workspaceName: string; role: string }
type InvitationRow = { id: string; organizationName?: string; role: string; status: string; expiresAt: string | Date }

/** Invitations that can still be answered: pending and not expired. */
export function pendingInvitations(rows: InvitationRow[], now = new Date()): PendingInvitation[] {
  return rows
    .filter(r => r.status === 'pending' && new Date(r.expiresAt).getTime() > now.getTime())
    .map(r => ({ id: r.id, workspaceName: r.organizationName || 'a workspace', role: r.role }))
}

async function loadInvitations(): Promise<PendingInvitation[]> {
  const res = await auth.organization.listUserInvitations()
  return res.error ? [] : pendingInvitations((res.data ?? []) as InvitationRow[])
}

/**
 * May this person name their own business here? Only a server admin (self-serve creation comes with billing, postponed)
 * whose session passed the passkey check: before it, POST /v1/workspaces answers 403 `admin_second_factor`, so the form
 * and "New workspace…" are not offered yet. The server checks it too.
 */
export const mayCreateWorkspace = (me: Me | null) => !!me && isInstanceAdmin(me) && !me.adminSecondFactor

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
  const admin = Boolean(me && isInstanceAdmin(me))
  const hash = useHash()
  const [invitations, setInvitations] = useState<PendingInvitation[] | null>(null)
  // A new install: its first admin sets it up with an AI agent first, unless they chose to do it by hand.
  const [manualSetup, setManualSetup] = useState(false)
  useEffect(() => {
    void loadInvitations().then(setInvitations)
  }, [])
  const leave = () => {
    window.location.hash = '#start'
  }
  // Account settings need no workspace (an admin without one manages sign-in methods there). Being signed in is
  // enough: `me` is null for someone in no workspace who is no instance admin, and they have an account all the same.
  if (hash.startsWith('#account')) return <AccountPage onBack={leave} />
  if (me && admin && hash.startsWith('#admin')) {
    if (me.adminSecondFactor) return <SecondFactorPrompt state={me.adminSecondFactor} onExit={leave} />
    return <AdminMode currentUserId={me.actorId} onExit={leave} />
  }
  if (me && admin && !me.impersonation && hash === INSTALL_SETUP_HASH) {
    if (me.adminSecondFactor) return <SecondFactorPrompt state={me.adminSecondFactor} onExit={leave} />
    return (
      <InstallSetup
        onExit={() => {
          // Opened by its link or from Server admin › Overview: leaving it goes on to naming the business, not the
          // agent page.
          rememberManual(true)
          setManualSetup(true)
          leave()
        }}
      />
    )
  }
  if (me && admin && !me.impersonation && (isAgentSetupHash(hash) || !choseManualSetup(me, manualSetup))) {
    // The setup page is part of Server admin: the passkey check first. Back goes on by hand (naming the business).
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
        onWorkspaceReady={onDone}
      />
    )
  }
  if (invitations === null) return <AuthPage>{null}</AuthPage>

  const extras = (
    <>
      {invitations.length > 0 && <InvitationList invitations={invitations} onOpen={onOpenInvite} />}
      {admin && (
        <button
          type="button"
          className="k-btn k-btn-secondary"
          onClick={() => (window.location.hash = '#admin')}
          title="Admin: providers, users and the setup checklist; no workspace needed"
        >
          Open Server admin
        </button>
      )}
      <button
        type="button"
        className="auth-switch"
        onClick={() => (window.location.hash = '#account')}
        title="Your name, sign-in methods and sessions; no workspace needed"
      >
        Account settings
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
        onInstallByHand={() => {
          rememberManual(true)
          window.location.hash = INSTALL_SETUP_HASH
        }}
      >
        {extras}
      </AdminStart>
    )
  return (
    <NoWorkspaceYet onDone={onDone} lostWorkspace={lostWorkspace} hasInvitations={invitations.length > 0}>
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
  return (
    <div className="page">
      <div className="pagebar">
        <button type="button" className="k-btn k-btn-ghost k-btn-sm" onClick={onBack} title="Back">
          Back
        </button>
        <b>Account</b>
      </div>
      <AccountSettings hasWorkspace={false} />
    </div>
  )
}

function InvitationList({ invitations, onOpen }: { invitations: PendingInvitation[]; onOpen: (id: string) => void }) {
  return (
    <div className="auth-invites" role="group" aria-label="Invitations">
      {invitations.map(i => (
        <div key={i.id} className="auth-invite">
          <span>
            You are invited to <b>{i.workspaceName}</b> as {i.role}.
          </span>
          <button
            type="button"
            className="k-btn k-btn-primary k-btn-sm"
            onClick={() => onOpen(i.id)}
            title={`Open the invitation to ${i.workspaceName}`}
          >
            Open
          </button>
        </div>
      ))}
    </div>
  )
}

/** This person may not create a workspace (only server admins do): they wait for a server admin to add them. */
function NoWorkspaceYet({
  hasInvitations,
  lostWorkspace,
  onDone,
  children,
}: {
  hasInvitations: boolean
  lostWorkspace: string | null
  onDone: () => void
  children: ReactNode
}) {
  return (
    <AuthPage>
      <div className="auth-card">
        <h1>
          {lostWorkspace
            ? deletedOnPurpose(lostWorkspace)
              ? `You deleted ${lostWorkspace}`
              : leftOnPurpose(lostWorkspace)
                ? `You left ${lostWorkspace}`
                : `You no longer have access to ${lostWorkspace}`
            : 'Waiting for an invitation'}
        </h1>
        <p>
          {hasInvitations
            ? 'Join a workspace you are invited to, or ask your server admin to add you to another.'
            : 'Ask your server admin to add you.'}
        </p>
        {children}
        <button type="button" className="auth-switch" onClick={() => void signOutAndForget().then(onDone)}>
          Use a different account
        </button>
      </div>
    </AuthPage>
  )
}
