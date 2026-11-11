// A small in-memory limit: at most `max` hits per key inside a sliding window. One API process,
// like Better Auth's own default limiter.
export function createRateLimiter({ max, windowMs }: { max: number; windowMs: number }) {
  const hits = new Map<string, number[]>()
  const SWEEP_AT = 10_000

  function sweep(now: number) {
    for (const [key, times] of hits) if (times.every(t => now - t >= windowMs)) hits.delete(key)
  }

  /** Records a hit and says whether it is still inside the limit. */
  return function allow(key: string, now = Date.now()): boolean {
    if (hits.size > SWEEP_AT) sweep(now)
    const recent = (hits.get(key) ?? []).filter(t => now - t < windowMs)
    if (recent.length >= max) {
      hits.set(key, recent)
      return false
    }
    hits.set(key, [...recent, now])
    return true
  }
}

/**
 * Failures per key inside a sliding window: `blocked` once there were `max` of them, without
 * recording anything, so a blocked caller can be turned away before any work is done. At most
 * `maxKeys` keys are kept: the one that failed longest ago goes first, so memory and work stay
 * bounded however many keys (addresses) a caller rotates through.
 */
export function createFailureLimiter({
  max,
  windowMs,
  maxKeys = 10_000,
}: {
  max: number
  windowMs: number
  maxKeys?: number
}) {
  const failures = new Map<string, number[]>()
  const recent = (key: string, now: number) => (failures.get(key) ?? []).filter(t => now - t < windowMs)
  return {
    blocked: (key: string, now = Date.now()) => recent(key, now).length >= max,
    fail(key: string, now = Date.now()) {
      const times = [...recent(key, now), now].slice(-max)
      failures.delete(key) // re-inserted last: the map's order is the order of the latest failure
      failures.set(key, times)
      while (failures.size > maxKeys) failures.delete(failures.keys().next().value!)
    },
    /** How many keys are kept (tests). */
    size: () => failures.size,
  }
}
