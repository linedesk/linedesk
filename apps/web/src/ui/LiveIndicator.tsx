import { useEffect, useState } from 'react'
import { clock } from '../time.ts'

/** Seconds since `since`, ticking once a second. */
export function useElapsed(since: Date): number {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])
  return Math.max(0, Math.floor((now - since.getTime()) / 1000))
}

/** Green pulsing dot, "Live" and a running clock. */
export function LiveIndicator({ since }: { since: Date }) {
  const seconds = useElapsed(since)
  return (
    <span className="k-livei k-livei-live">
      <span className="k-livei-dot" aria-hidden="true" />
      Live
      <time>{clock(seconds)}</time>
    </span>
  )
}
