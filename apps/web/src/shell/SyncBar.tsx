import { useEffect, useState } from 'react'
import { useSnapshot } from '../store.tsx'
import { useOnline } from './presence.ts'
import { syncStatusText } from './syncStatus.ts'

/**
 * Slim bar at the bottom of the window as soon as the app is offline (the browser says so, or the
 * server could not be reached), and after reconnecting until the waiting changes are sent. A change
 * that is simply on its way while online shows nothing.
 */
export function SyncBar() {
  const { pending } = useSnapshot()
  const online = useOnline()
  const [wasOffline, setWasOffline] = useState(false)
  useEffect(() => {
    if (!online) setWasOffline(true)
    else if (pending === 0) setWasOffline(false)
  }, [online, pending])
  const text = !online || wasOffline ? syncStatusText({ online, pending }) : null
  return text ? (
    <div className="sync-bar" role="status">
      {text}
    </div>
  ) : null
}
