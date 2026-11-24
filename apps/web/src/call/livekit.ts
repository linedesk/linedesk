// LiveKit's client is about a third of the app's code and only needed in a call (listening in, taking
// over, a test call). It loads on its own, so the first screen does not wait for it, and is fetched once
// the browser is idle after the first screen (preloadLiveKit), so a call never waits for it either.
import { i18n } from '../i18n/index.tsx'
export type LiveKit = typeof import('livekit-client')

let loading: Promise<LiveKit> | null = null

/** The LiveKit client; loaded once. A failed load (offline, or a deploy removed the file) is tried again next time. */
export function loadLiveKit(): Promise<LiveKit> {
  loading ??= import('livekit-client').catch((error: unknown) => {
    loading = null
    throw error
  })
  return loading
}

/** The first screen's own requests (the calls, the session's settings) go first. */
const PRELOAD_AFTER_MS = 3000

/** Fetches the LiveKit client after the first screen, once the browser has nothing else to do. */
export function preloadLiveKit() {
  const idle = window.requestIdleCallback ?? ((run: () => void) => setTimeout(run, 0))
  const timer = setTimeout(() => idle(() => void loadLiveKit().catch(() => {})), PRELOAD_AFTER_MS)
  return () => clearTimeout(timer)
}

/**
 * Fetches the LiveKit client now, for a page that may start a call any moment (the test call button): the click then
 * does not wait for its download. A failure is tried again when the call starts.
 */
export function preloadNow() {
  void loadLiveKit().catch(() => {})
}

/** What a member reads when the call code could not load. */
export const loadFailed = () => i18n().t('call.live.loadFailed')
