import { useCallback, useEffect, useState } from 'react'
import { fetchMe, type Me } from './auth.ts'
import { Inbox } from './Inbox.tsx'
import { Login } from './Login.tsx'
import { StoreProvider } from './store.tsx'

type Session = { state: 'loading' } | { state: 'signedOut' } | { state: 'ready'; me: Me }

export function App() {
  const [session, setSession] = useState<Session>({ state: 'loading' })
  const refresh = useCallback(async () => {
    const me = await fetchMe()
    setSession(me?.workspace ? { state: 'ready', me } : { state: 'signedOut' })
  }, [])
  useEffect(() => { void refresh() }, [refresh])

  if (session.state === 'loading') return null
  if (session.state === 'signedOut') return <Login onDone={refresh} />
  return (
    <StoreProvider workspaceId={session.me.workspace!.id}>
      <Inbox me={session.me} onSignedOut={refresh} />
    </StoreProvider>
  )
}
