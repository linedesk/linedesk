import { useCallback, useEffect, useState } from 'react'
import { fetchMe, isSignedIn, type Me } from './auth.ts'
import { CreateWorkspace } from './CreateWorkspace.tsx'
import { Workspace } from './Workspace.tsx'
import { Login } from './Login.tsx'
import { StoreProvider } from './store.tsx'

type Session = { state: 'loading' } | { state: 'signedOut' } | { state: 'needsWorkspace' } | { state: 'ready'; me: Me }

async function loadSession(): Promise<Session> {
  const me = await fetchMe()
  if (me?.workspace) return { state: 'ready', me }
  // Signed in through a link or SSO for the first time: no workspace yet.
  return (await isSignedIn()) ? { state: 'needsWorkspace' } : { state: 'signedOut' }
}

export function App() {
  const [session, setSession] = useState<Session>({ state: 'loading' })
  const refresh = useCallback(async () => setSession(await loadSession()), [])
  useEffect(() => {
    void refresh()
  }, [refresh])

  if (session.state === 'loading') return null
  if (session.state === 'signedOut') return <Login onDone={refresh} />
  if (session.state === 'needsWorkspace') return <CreateWorkspace onDone={refresh} />
  return (
    <StoreProvider workspaceId={session.me.workspace!.id}>
      <Workspace me={session.me} onSignedOut={refresh} />
    </StoreProvider>
  )
}
