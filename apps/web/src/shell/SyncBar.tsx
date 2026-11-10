import { useEffect, useState } from 'react'
import { useSnapshot } from '../store.tsx'
import { syncStatusText } from './syncStatus.ts'

/**
 * Slim bar at the bottom of the window while the app is offline, and after reconnecting until
 * the waiting changes are sent. A change that is simply on its way while online shows nothing.
 */
export function SyncBar() {
  const { online, pending } = useSnapshot()
  const [wasOffline, setWasOffline] = useState(false)
  useEffect(() => {
    if (!online) setWasOffline(true)
    else if (pending === 0) setWasOffline(false)
  }, [online, pending])
  const text = !online || wasOffline ? syncStatusText({ online, pending }) : null
  return text ? <div className="sync-bar" role="status">{text}</div> : null
}
