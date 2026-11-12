import { useEffect, useRef, useState } from 'react'
import { isNewVersion, runningEntryScript } from './newVersion.ts'

const CHECK_EVERY_MS = 5 * 60_000

/**
 * A tab left open through a deploy keeps running the old app. This checks the served index.html when
 * the tab is focused again and every few minutes, and offers a reload once the build has changed.
 */
export function NewVersionBar() {
  const [available, setAvailable] = useState(false)
  const running = useRef(runningEntryScript())
  useEffect(() => {
    if (running.current === null) return // dev server: no hashed build to compare
    let stopped = false
    async function check() {
      if (document.visibilityState === 'hidden') return
      try {
        const response = await fetch('/', { cache: 'no-store', headers: { Accept: 'text/html' } })
        if (response.ok && !stopped && isNewVersion(running.current, await response.text())) setAvailable(true)
      } catch {
        // Offline or the server is busy: the next check tries again.
      }
    }
    const timer = setInterval(() => void check(), CHECK_EVERY_MS)
    window.addEventListener('focus', check)
    document.addEventListener('visibilitychange', check)
    return () => {
      stopped = true
      clearInterval(timer)
      window.removeEventListener('focus', check)
      document.removeEventListener('visibilitychange', check)
    }
  }, [])
  if (!available) return null
  return (
    <div className="nv-bar" role="status">
      <span>A new version is available.</span>
      <button type="button" className="nv-reload" onClick={() => window.location.reload()}>
        Reload
      </button>
    </div>
  )
}
