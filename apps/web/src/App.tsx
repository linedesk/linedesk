import { useCallback, useEffect, useState } from 'react'
import { CreateWorkspace } from './CreateWorkspace.tsx'
import { forgetBeyond } from './localData.ts'
import { Login } from './Login.tsx'
import { backoffMs } from './retry.ts'
import { loadSession, type Session } from './session.ts'
import { Onboarding } from './onboarding/Onboarding.tsx'
import { ImpersonationFrame } from './shell/ImpersonationBar.tsx'
import { TabWorkspaceGuard } from './shell/TabWorkspaceNotice.tsx'
import { DISABLED_WORKSPACE, StoreProvider } from './store.tsx'
import { Workspace } from './Workspace.tsx'
import { AcceptInvite, clearInviteId, readInviteId } from './team/AcceptInvite.tsx'
import { BootScreen } from './ui/BootScreen.tsx'

/** Shown when the server is unreachable and this device has nothing to open offline. It retries on its own. */
function Unreachable() {
  return (
    <div className="boot" role="status">
      <b>Can't reach Linedesk</b>
      <span>Trying again… This page continues on its own once the connection is back.</span>
    </div>
  )
}

export function App() {
  const [session, setSession] = useState<Session>({ state: 'loading' })
  const [inviteId, setInviteId] = useState(readInviteId)
  // Finishing onboarding is a queued command; the app moves on without waiting for it.
  const [onboarded, setOnboarded] = useState(false)
  const refresh = useCallback(async () => setSession(await loadSession()), [])
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
  if (session.state === 'loading') return <BootScreen line="Opening Linedesk…" />
  if (session.state === 'unreachable') return <Unreachable />
  if (session.state === 'signedOut') return <Login onDone={refresh} />
  if (session.state === 'needsWorkspace') {
    return (
      <ImpersonationFrame impersonation={session.impersonation}>
        <CreateWorkspace onDone={refresh} />
      </ImpersonationFrame>
    )
  }
  return (
    <ImpersonationFrame impersonation={session.me.impersonation ?? null}>
      <StoreProvider
        workspaceId={session.me.workspace!.id}
        readOnly={session.me.workspace?.disabled ? DISABLED_WORKSPACE : undefined}
      >
        <TabWorkspaceGuard me={session.me}>
          {session.me.onboarding && !onboarded ? (
            <Onboarding me={session.me} state={session.me.onboarding} onDone={() => setOnboarded(true)} />
          ) : (
            <Workspace me={session.me} onSignedOut={refresh} />
          )}
        </TabWorkspaceGuard>
      </StoreProvider>
    </ImpersonationFrame>
  )
}
