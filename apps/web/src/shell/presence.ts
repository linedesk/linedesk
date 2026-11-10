// What the inbox header says about the assistant. Green means calls are really answered: a number
// is connected and the server has the voice stack. Anything else is said plainly, with a way to fix it.
import { useEffect, useState, useSyncExternalStore } from 'react'
import { useSnapshot } from '../store.tsx'

export type Presence =
  | { kind: 'answering' }
  | { kind: 'offline' }
  /** `number`: no phone number is connected; `voice`: the server lacks LiveKit or a speech, language model or voice provider. */
  | { kind: 'notAnswering'; reason: 'number' | 'voice' }
  /** Not known yet (the first check is on its way): show nothing rather than guess. */
  | { kind: 'unknown' }

export function presenceOf({
  online,
  hasNumber,
  voiceReady,
}: {
  online: boolean
  hasNumber: boolean
  voiceReady: boolean | null
}): Presence {
  if (!online) return { kind: 'offline' }
  if (!hasNumber) return { kind: 'notAnswering', reason: 'number' }
  if (voiceReady === null) return { kind: 'unknown' }
  return voiceReady ? { kind: 'answering' } : { kind: 'notAnswering', reason: 'voice' }
}

const subscribeBrowserOnline = (changed: () => void) => {
  window.addEventListener('online', changed)
  window.addEventListener('offline', changed)
  return () => {
    window.removeEventListener('online', changed)
    window.removeEventListener('offline', changed)
  }
}

/** Offline as soon as the browser says so, or once the store could not reach the server. */
export function useOnline(): boolean {
  const { online } = useSnapshot()
  const browserOnline = useSyncExternalStore(subscribeBrowserOnline, () => navigator.onLine)
  return online && browserOnline
}

const CHECK_EVERY_MS = 60_000

/** Whether the server can answer calls (GET /v1/assistant/status), checked again every minute and when back online. */
export function useVoiceReady(): boolean | null {
  const [ready, setReady] = useState<boolean | null>(null)
  useEffect(() => {
    let live = true
    const check = async () => {
      try {
        const res = await fetch('/v1/assistant/status', { credentials: 'include' })
        if (res.ok && live) setReady(((await res.json()) as { voiceReady: boolean }).voiceReady)
      } catch {
        // Offline: keep the last answer; the header says offline anyway.
      }
    }
    void check()
    const timer = setInterval(check, CHECK_EVERY_MS)
    window.addEventListener('online', check)
    return () => {
      live = false
      clearInterval(timer)
      window.removeEventListener('online', check)
    }
  }, [])
  return ready
}
