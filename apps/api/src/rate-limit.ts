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
