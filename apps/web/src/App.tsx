import { useCallback, useEffect, useState } from 'react'
import { CreateWorkspace } from './CreateWorkspace.tsx'
import { Login } from './Login.tsx'
import { backoffMs } from './retry.ts'
import { loadSession, type Session } from './session.ts'
import { StoreProvider } from './store.tsx'
import { Workspace } from './Workspace.tsx'

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
  const refresh = useCallback(async () => setSession(await loadSession()), [])
  useEffect(() => { void refresh() }, [refresh])

  // While the server cannot be reached, keep asking with growing pauses; also right away when the browser is back online.
  const waiting = session.state === 'unreachable' || (session.state === 'ready' && session.offline)
  useEffect(() => {
    if (!waiting) return
    let attempt = 0
    let timer: ReturnType<typeof setTimeout>
    const tryAgain = async () => {
      const next = await loadSession()
      if (next.state === 'unreachable' || (next.state === 'ready' && next.offline)) timer = setTimeout(tryAgain, backoffMs(++attempt))
      else setSession(next)
    }
    timer = setTimeout(tryAgain, backoffMs(attempt))
    const now = () => { clearTimeout(timer); void tryAgain() }
    window.addEventListener('online', now)
    return () => { clearTimeout(timer); window.removeEventListener('online', now) }
  }, [waiting])

  if (session.state === 'loading') return null
  if (session.state === 'unreachable') return <Unreachable />
  if (session.state === 'signedOut') return <Login onDone={refresh} />
  if (session.state === 'needsWorkspace') return <CreateWorkspace onDone={refresh} />
  return (
    <StoreProvider workspaceId={session.me.workspace!.id}>
      <Workspace me={session.me} onSignedOut={refresh} />
    </StoreProvider>
  )
}
