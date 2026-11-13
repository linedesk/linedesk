import { useCallback, useEffect, useMemo, useState } from 'react'
import { forgetBeyond } from './localData.ts'
import { NoWorkspace } from './NoWorkspace.tsx'
import { Login } from './Login.tsx'
import { backoffMs } from './retry.ts'
import { loadSession, renamedWorkspace, type Session } from './session.ts'
import { AGENT_SETUP_HASH, AgentSetup, choseManualSetup, rememberManual } from './onboarding/AgentSetup.tsx'
import { INSTALL_SETUP_HASH, InstallSetup } from './onboarding/InstallSetup.tsx'
import { SecondFactorPrompt } from './admin/SecondFactorPrompt.tsx'
import { Onboarding } from './onboarding/Onboarding.tsx'
import { ImpersonationFrame } from './shell/ImpersonationBar.tsx'
import { switchToWorkspace } from './shell/invitations.ts'
import { linkNotice, linkWorkspace, linkWorkspaceTarget, withoutLinkWorkspace } from './shell/useRoute.ts'
import { TabWorkspaceGuard } from './shell/TabWorkspaceNotice.tsx'
import { DISABLED_WORKSPACE, StoreProvider } from './store.tsx'
import { Workspace } from './Workspace.tsx'
import { AcceptInvite, clearInviteId, readInviteId } from './team/AcceptInvite.tsx'
import { BootScreen } from './ui/BootScreen.tsx'
import { brandName } from './brand.ts'

/** Shown when the server is unreachable and this device has nothing to open offline. It retries on its own. */
function Unreachable() {
  return (
    <div className="boot" role="status">
      <b>Can't reach {brandName()}</b>
      <span>Trying again… This page continues on its own once the connection is back.</span>
    </div>
  )
}

/** Whether the address is this hash (#setup-agent, #setup-install), followed as it changes. */
function useHashIs(hash: string): boolean {
  const [on, setOn] = useState(() => window.location.hash === hash)
  useEffect(() => {
    const follow = () => setOn(window.location.hash === hash)
    window.addEventListener('hashchange', follow)
    return () => window.removeEventListener('hashchange', follow)
  }, [hash])
  return on
}

/** Whether the address is in Admin (#admin…), followed as it changes. */
function useAdminHash(): boolean {
  const [admin, setAdmin] = useState(() => window.location.hash.startsWith('#admin'))
  useEffect(() => {
    const follow = () => setAdmin(window.location.hash.startsWith('#admin'))
    window.addEventListener('hashchange', follow)
    return () => window.removeEventListener('hashchange', follow)
  }, [])
  return admin
}

const LINK_SWITCH = 'linedesk.linkSwitch'

/** Whether this tab already switched for the link to `id` (and remembers it now); null forgets it. */
function attemptedSwitch(id: string | null): boolean {
  try {
    const before = sessionStorage.getItem(LINK_SWITCH)
    if (id) sessionStorage.setItem(LINK_SWITCH, id)
    else sessionStorage.removeItem(LINK_SWITCH)
    return !!id && before === id
  } catch {
    return false // private mode: no guard, the switch itself checks membership
  }
}

export function App() {
  const [session, setSession] = useState<Session>({ state: 'loading' })
  const [inviteId, setInviteId] = useState(readInviteId)
  // Finishing onboarding is a queued command; the app moves on without waiting for it.
  const [onboarded, setOnboarded] = useState(false)
  const adminHash = useAdminHash()
  const agentSetupHash = useHashIs(AGENT_SETUP_HASH)
  const installSetupHash = useHashIs(INSTALL_SETUP_HASH)
  // An instance admin sets up with an AI agent first (AgentSetup.tsx), unless they chose to do it by hand.
  const [manualSetup, setManualSetup] = useState(choseManualSetup)
  const refresh = useCallback(async () => setSession(await loadSession()), [])
  // A link from an email names its workspace (`?ws=` in the hash): read once at load, settled before the app opens.
  const [link, setLink] = useState(() => linkWorkspace(window.location.hash))
  const [notice, setNotice] = useState<string | null>(null)
  const target = useMemo(
    () =>
      session.state === 'ready' && link
        ? linkWorkspaceTarget(link, session.me.workspace!.id, session.me.workspaces, session.offline)
        : null,
    [session, link],
  )
  useEffect(() => {
    if (!link || !target) return
    // A workspace the member belongs to: make it the session's and reload into the same page (it keeps the link,
    // which then names this workspace). Could not switch: the inbox says which workspace the link is for.
    if (target.kind === 'switch') {
      const failed = () => {
        window.history.replaceState(null, '', '#calls')
        setNotice(linkNotice({ kind: 'elsewhere', workspace: target.workspace }))
        setLink(null)
      }
      // Once per link and tab: should the reload not land in it, never switch again in a loop.
      if (attemptedSwitch(link)) return failed()
      switchToWorkspace(link, null).catch(failed)
      return
    }
    attemptedSwitch(null)
    // This workspace: the page opens without the parameter. Another one: the inbox, and why.
    window.history.replaceState(
      null,
      '',
      target.kind === 'here' ? withoutLinkWorkspace(window.location.hash) : '#calls',
    )
    setNotice(linkNotice(target))
    setLink(null)
  }, [link, target])
  useEffect(() => {
    void refresh()
  }, [refresh])
  // Local data the session does not cover (signed out, removed from a workspace) is deleted.
  useEffect(() => {
    void forgetBeyond(session)
  }, [session])

  // While the server cannot be reached, keep asking with growing pauses; also right away when the browser is back online.
  const waiting = session.state === 'unreachable' || (session.state === 'ready' && session.offline)
  useEffect(() => {
    if (!waiting) return
    let attempt = 0
    let timer: ReturnType<typeof setTimeout>
    const tryAgain = async () => {
      const next = await loadSession()
      if (next.state === 'unreachable' || (next.state === 'ready' && next.offline))
        timer = setTimeout(tryAgain, backoffMs(++attempt))
      else setSession(next)
    }
    timer = setTimeout(tryAgain, backoffMs(attempt))
    const now = () => {
      clearTimeout(timer)
      void tryAgain()
    }
    window.addEventListener('online', now)
    return () => {
      clearTimeout(timer)
      window.removeEventListener('online', now)
    }
  }, [waiting])

  if (inviteId) {
    const leaveInvite = () => {
      clearInviteId()
      setInviteId(null)
      void refresh()
    }
    return <AcceptInvite invitationId={inviteId} onDone={leaveInvite} />
  }
  if (session.state === 'loading') return <BootScreen line={`Opening ${brandName()}…`} />
  if (session.state === 'unreachable') return <Unreachable />
  if (session.state === 'signedOut') return <Login onDone={refresh} />
  if (target) return <BootScreen line={`Opening ${target.kind === 'switch' ? target.workspace.name : brandName()}…`} />
  if (session.state === 'needsWorkspace') {
    return (
      <ImpersonationFrame impersonation={session.impersonation}>
        <NoWorkspace
          me={session.me}
          lostWorkspace={session.lostWorkspace}
          onDone={refresh}
          onOpenInvite={setInviteId}
        />
      </ImpersonationFrame>
    )
  }
  const instanceAdmin = session.me.permissions.includes('instance:admin') && !session.me.impersonation
  const settingUp = session.me.onboarding && !onboarded
  // The install by hand, step by step (InstallSetup.tsx); leaving it goes on to the business setup.
  if (instanceAdmin && installSetupHash) {
    if (session.me.adminSecondFactor)
      return <SecondFactorPrompt state={session.me.adminSecondFactor} onExit={() => (window.location.hash = '')} />
    return (
      <InstallSetup
        onExit={() => {
          // However it was opened, leaving it goes on to the business setup, not back to the agent page.
          rememberManual(true)
          setManualSetup(true)
          if (window.location.hash === INSTALL_SETUP_HASH) window.location.hash = ''
          void refresh()
        }}
      />
    )
  }
  if (instanceAdmin && !adminHash && (agentSetupHash || (settingUp && !manualSetup))) {
    const leave = () => {
      if (window.location.hash === AGENT_SETUP_HASH) window.location.hash = ''
    }
    return (
      <AgentSetup
        onManual={installFirst => {
          setManualSetup(true)
          // The install by hand, step by step (off on Cloud: it opens the setup checklist instead).
          if (installFirst) window.location.hash = INSTALL_SETUP_HASH
          else leave()
        }}
        onDone={() => {
          leave()
          void refresh()
        }}
      />
    )
  }
  return (
    <ImpersonationFrame impersonation={session.me.impersonation ?? null}>
      <StoreProvider
        workspaceId={session.me.workspace!.id}
        account={session.me.actorId}
        readOnly={session.me.workspace?.disabled ? DISABLED_WORKSPACE : undefined}
      >
        <TabWorkspaceGuard me={session.me}>
          {/* An instance admin can open Admin in the middle of onboarding (the business step links to Providers). */}
          {session.me.onboarding && !onboarded && !(adminHash && session.me.permissions.includes('instance:admin')) ? (
            <Onboarding
              me={session.me}
              state={session.me.onboarding}
              onDone={() => setOnboarded(true)}
              onRenamed={name =>
                setSession(s => (s.state === 'ready' ? { ...s, me: renamedWorkspace(s.me, name) } : s))
              }
            />
          ) : (
            <Workspace me={session.me} onSignedOut={refresh} onSessionStale={refresh} notice={notice} />
          )}
        </TabWorkspaceGuard>
      </StoreProvider>
    </ImpersonationFrame>
  )
}
