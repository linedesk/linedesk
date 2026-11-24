// Playback helpers for the recording player, and the one place the keyboard reaches it from.
const SPEEDS = [1, 1.5, 2] as const
export const SEEK_STEP_SECONDS = 5

export const nextSpeed = (speed: number): number => SPEEDS[(SPEEDS.indexOf(speed as (typeof SPEEDS)[number]) + 1) % SPEEDS.length]!

/** Where a pointer at `clientX` is on a track from `left` with `width`, as seconds into the recording. */
export function seekSeconds(clientX: number, left: number, width: number, duration: number): number {
  if (width <= 0 || duration <= 0) return 0
  return Math.max(0, Math.min(1, (clientX - left) / width)) * duration
}

/** The audio element reports no usable length for some streamed files; then the call's own duration is used. */
export function recordingLength(reported: number, callDurationSec: number | null): number {
  return Number.isFinite(reported) && reported > 0 ? reported : callDurationSec ?? 0
}

/**
 * After the audio element failed: whether the call simply has no recording file (the API answers 404: the recording
 * never arrived or is gone from the store) rather than a recording that could not be played. Asks for one byte; a
 * network error or any other answer counts as a failure to show.
 */
export async function recordingMissing(url: string, fetchFn: typeof fetch = fetch): Promise<boolean> {
  try {
    const response = await fetchFn(url, { headers: { range: 'bytes=0-0' }, credentials: 'same-origin' })
    void response.body?.cancel()
    return response.status === 404
  } catch {
    return false
  }
}

let toggleMounted: (() => void) | null = null

/** The mounted player registers its toggle here; returns how to unregister. */
export function registerPlayer(toggle: () => void): () => void {
  toggleMounted = toggle
  return () => { if (toggleMounted === toggle) toggleMounted = null }
}

/** Play or pause the recording on screen. False when there is none, so the key keeps its normal meaning. */
export function togglePlayback(): boolean {
  toggleMounted?.()
  return toggleMounted !== null
}
