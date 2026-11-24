import { useEffect, useRef } from 'react'
import { handleKey, type KeyContext } from './keys.ts'
import type { Toaster } from './useToast.ts'

/** One keydown listener for the app. Actions it triggers count as keyboard use (no "Next time, press…" tip). */
export function useKeyboard(keys: KeyContext, via: Toaster['via']) {
  const latest = useRef(keys)
  latest.current = keys
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (via('key', () => handleKey(e, latest.current))) e.preventDefault() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [via])
}
