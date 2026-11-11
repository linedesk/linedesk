// What the inbox header says about the assistant. Green means calls are really answered: a number
// is connected and the server has the voice stack. Anything else is said plainly, with a way to fix it.
import { useEffect, useSyncExternalStore } from 'react'
import { refreshQuery, useQuery } from '../cachedQuery.ts'
import { useRows, useSnapshot } from '../store.tsx'
import { useLoadState } from '../ui/LoadStates.tsx'

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
  /** null: the numbers have not arrived on this device yet. */
  hasNumber: boolean | null
  voiceReady: boolean | null
}): Presence {
  if (!online) return { kind: 'offline' }
  if (hasNumber === null) return { kind: 'unknown' }
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

const VOICE_READY = 'assistant.status'
async function loadVoiceReady(): Promise<boolean> {
  const res = await fetch('/v1/assistant/status', { credentials: 'include' })
  if (!res.ok) throw new Error(`The server answered ${res.status}`)
  return ((await res.json()) as { voiceReady: boolean }).voiceReady
}

/**
 * Whether the server can answer calls (GET /v1/assistant/status): the last answer at once (also
 * across page loads), checked again every minute and when back online. Offline keeps the last answer.
 */
export function useVoiceReady(): boolean | null {
  const ready = useQuery(VOICE_READY, loadVoiceReady, { persist: true }).data
  useEffect(() => {
    const check = () => void refreshQuery(VOICE_READY)
    const timer = setInterval(check, CHECK_EVERY_MS)
    window.addEventListener('online', check)
    return () => {
      clearInterval(timer)
      window.removeEventListener('online', check)
    }
  }, [])
  return ready ?? null
}

/** Whether a number is connected; null until the numbers first arrive on this device. */
function useHasNumber(): boolean | null {
  const count = useRows('phone_numbers').length
  return useLoadState('phone_numbers') === 'ready' ? count > 0 : null
}

/** The one answer to "is the assistant answering calls?", shared by the header, Phone numbers and onboarding. */
export function usePresence(): Presence {
  return presenceOf({
    online: useOnline(),
    hasNumber: useHasNumber(),
    voiceReady: useVoiceReady(),
  })
}
