// Where the app is, kept in the URL hash so reload and the browser's Back work:
// `#calls` (the list), `#call/<id>` (one call), `#assistant`, `#account`.
import { useCallback, useEffect, useRef, useState } from 'react'
import { isPageRoute, type Route } from './pages.tsx'

export type Location = { route: Route; callId: string | null }

const CALL_PREFIX = 'call/'
export const callHash = (id: string) => `#${CALL_PREFIX}${id}`

export function parseHash(hash: string): Location {
  const value = hash.replace(/^#/, '')
  if (value.startsWith(CALL_PREFIX) && value.length > CALL_PREFIX.length) return { route: 'calls', callId: value.slice(CALL_PREFIX.length) }
  return { route: isPageRoute(value) ? value : 'calls', callId: null }
}

export function useRoute() {
  const [location, setLocation] = useState(() => parseHash(window.location.hash))
  /** True when the open call was reached from the list in this tab, so closing it is a step back. */
  const openedFromList = useRef(false)
  useEffect(() => {
    const onHash = () => setLocation(parseHash(window.location.hash))
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  const replace = useCallback((hash: string) => {
    window.history.replaceState(null, '', hash)
    setLocation(parseHash(hash))
  }, [])
  const go = useCallback((to: Route) => {
    window.location.hash = to
    setLocation({ route: to, callId: null })
  }, [])
  /** Opening from the list adds a history entry; moving between calls replaces it, so Back returns to the list. */
  const openCall = useCallback((id: string) => {
    const current = parseHash(window.location.hash)
    if (current.callId) return replace(callHash(id))
    openedFromList.current = current.route === 'calls'
    window.location.hash = callHash(id)
    setLocation({ route: 'calls', callId: id })
  }, [replace])
  const closeCall = useCallback(() => {
    if (!parseHash(window.location.hash).callId) return
    if (!openedFromList.current) return replace('#calls')
    openedFromList.current = false
    window.history.back()
  }, [replace])

  return { ...location, go, openCall, closeCall }
}
export type RouteApi = ReturnType<typeof useRoute>
