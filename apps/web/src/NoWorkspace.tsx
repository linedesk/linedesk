// Signed in, but a member of no workspace: just signed up, skipped an invitation ("Not now"), or
// removed from the last one. What they can do here:
// - join a workspace they are invited to (a skipped invitation stays here until it is answered);
// - name their own business, where this server lets them (sign-up open, or an instance admin);
// - open Account settings, which need no workspace, or sign out ("Use a different account");
// - an instance admin opens Admin, which needs no workspace. Right after setting up the server they land on "Name
//   your business" too (the first workspace), with Admin one click away; once they have a workspace, / opens it.
import { type ReactNode, useEffect, useState } from 'react'
import { AdminMode } from './admin/AdminMode.tsx'
import { SecondFactorPrompt } from './admin/SecondFactorPrompt.tsx'
import { auth, fetchAuthMethods, isInstanceAdmin, type Me } from './auth.ts'
import { CreateWorkspace } from './CreateWorkspace.tsx'
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

/** May this person name their own business here? The server checks it too (POST /v1/workspaces). */
export const mayCreateWorkspace = (signUpOpen: boolean, me: Me | null) =>
  signUpOpen || Boolean(me && isInstanceAdmin(me))

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
  const [signUpOpen, setSignUpOpen] = useState<boolean | null>(null)
  // A new install: its first admin sets it up with an AI agent first, unless they chose to do it by hand.
  const [manualSetup, setManualSetup] = useState(false)
  useEffect(() => {
    void loadInvitations().then(setInvitations)
    fetchAuthMethods({ attempts: 3 }).then(
      m => setSignUpOpen(m.signUp !== false),
      () => setSignUpOpen(false),
    )
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
          // Opened by its link or from Admin › Overview: leaving it goes on to naming the business, not the agent page.
          rememberManual(true)
          setManualSetup(true)
          leave()
        }}
      />
    )
  }
  if (me && admin && !me.impersonation && (isAgentSetupHash(hash) || !choseManualSetup(me, manualSetup)))
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
  if (invitations === null || signUpOpen === null) return <AuthPage>{null}</AuthPage>

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
          Open Admin
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
        onInstallByHand={() => {
          rememberManual(true)
          window.location.hash = INSTALL_SETUP_HASH
        }}
      >
        {extras}
      </AdminStart>
    )
  if (mayCreateWorkspace(signUpOpen, me))
    return (
      <CreateWorkspace onDone={onDone} lostWorkspace={lostWorkspace}>
        {extras}
      </CreateWorkspace>
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

/** Sign-up is closed and this person may not create a workspace: they join by invitation. */
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
            : 'You are not in a workspace yet'}
        </h1>
        <p>
          {hasInvitations
            ? 'Join a workspace you are invited to.'
            : 'On this server, workspaces are set up by an administrator. Ask yours to invite you.'}
        </p>
        {children}
        <button type="button" className="auth-switch" onClick={() => void signOutAndForget().then(onDone)}>
          Use a different account
        </button>
      </div>
    </AuthPage>
  )
}
