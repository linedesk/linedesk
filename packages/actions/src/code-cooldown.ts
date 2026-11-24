// How long someone waits before the next email code (sign-up and sign-in pages, LIN-661): a cooldown that grows with
// each code instead of a hard cap, so a person who did not get the email can always ask again, only a little later
// each time. The API enforces it (apps/api/src/self-serve.ts, apps/api/src/sign-in-limits.ts); the pages count down
// with the same steps and take the server's `retryAfter` when it differs.

/** Seconds to wait after the 1st, 2nd, 3rd and 4th code; every later one waits the last step. */
export const CODE_COOLDOWN_STEPS_S = [30, 120, 300, 600] as const

/** Codes this long apart start over at the first step. */
export const CODE_COOLDOWN_RESET_MS = 60 * 60_000

/** Seconds to wait after the `sent`-th code in a row (1: the first). 0 before any code. */
export function codeCooldownS(sent: number): number {
  if (sent <= 0) return 0
  return CODE_COOLDOWN_STEPS_S[Math.min(sent, CODE_COOLDOWN_STEPS_S.length) - 1]!
}

/**
 * Milliseconds until another code may go out, given the times of the codes sent so far (any order) and now. The codes
 * in a row are those since the last gap of CODE_COOLDOWN_RESET_MS; 0 when none or the cooldown has passed.
 */
export function codeCooldownLeftMs(sentAt: readonly number[], now: number): number {
  const times = [...sentAt].filter(t => t <= now).sort((a, b) => a - b)
  if (!times.length) return 0
  const last = times[times.length - 1]!
  if (now - last >= CODE_COOLDOWN_RESET_MS) return 0
  let inRow = 1
  for (let i = times.length - 1; i > 0 && times[i]! - times[i - 1]! < CODE_COOLDOWN_RESET_MS; i--) inRow++
  return Math.max(0, last + codeCooldownS(inRow) * 1000 - now)
}
