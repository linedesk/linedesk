// A small in-memory limit: at most `max` hits per key inside a sliding window. One API process,
// like Better Auth's own default limiter. At most `maxKeys` keys are kept (the one hit longest ago
// goes first), so memory and work stay bounded however many keys a caller rotates through.
export function createRateLimiter({
  max,
  windowMs,
  maxKeys = 50_000,
}: {
  max: number
  windowMs: number
  maxKeys?: number
}) {
  const hits = new Map<string, number[]>()
  const recent = (key: string, now: number) => (hits.get(key) ?? []).filter(t => now - t < windowMs)

  /** Records a hit and says whether it is still inside the limit. */
  function allow(key: string, now = Date.now()): boolean {
    const times = recent(key, now)
    if (times.length >= max) return false
    hits.delete(key) // re-inserted last: the map's order is the order of the latest hit
    hits.set(key, [...times, now])
    dropOldest(hits, maxKeys, times => times.every(t => now - t >= windowMs))
    return true
  }
  /** Whether the next hit would be refused, without recording one. */
  allow.full = (key: string, now = Date.now()) => recent(key, now).length >= max
  /** When the next hit would be let through again (ms since the epoch): `now` while it would be already. */
  allow.freeAt = (key: string, now = Date.now()) => {
    const times = recent(key, now)
    return times.length < max ? now : times[times.length - max]! + windowMs
  }
  return allow
}

/**
 * Keeps a map (ordered oldest first) at `maxKeys`: drops expired entries from the front, then the
 * oldest ones, and hands each dropped one to `dropped`. Amortised O(1): only the front is touched.
 */
function dropOldest<V>(
  map: Map<string, V>,
  maxKeys: number,
  expired: (value: V) => boolean,
  dropped?: (key: string, value: V) => void,
) {
  for (const [key, value] of map) {
    if (map.size <= maxKeys && !expired(value)) return
    map.delete(key)
    dropped?.(key, value)
  }
}

/**
 * Failures per key inside a sliding window: `blocked` once there were `max` of them, without
 * recording anything, so a blocked caller can be turned away before any work is done. Keys still
 * counting and blocked keys are kept apart: at most `maxKeys` counting keys (the one that failed
 * longest ago goes first) and up to `maxBlocked` blocked ones, so memory and work stay bounded
 * however many keys (addresses) a caller rotates through, and a flood of new keys can not push a
 * blocked key out (that would lift its block). A block that has lifted moves its failures still in
 * the window back to the counting keys, so it is not a fresh start. Only the front of each map is
 * ever scanned. These limits are per process and start empty after a restart; the caps that must
 * hold across those are in the database (sign-in-limits.ts).
 */
export function createFailureLimiter({
  max,
  windowMs,
  maxKeys = 10_000,
  maxBlocked = 10_000,
}: {
  max: number
  windowMs: number
  maxKeys?: number
  maxBlocked?: number
}) {
  const counting = new Map<string, number[]>()
  const blockedKeys = new Map<string, number[]>()
  const recent = (key: string, now: number) =>
    (blockedKeys.get(key) ?? counting.get(key) ?? []).filter(t => now - t < windowMs)
  return {
    blocked: (key: string, now = Date.now()) => recent(key, now).length >= max,
    fail(key: string, now = Date.now()) {
      const times = [...recent(key, now), now].slice(-max)
      counting.delete(key)
      blockedKeys.delete(key) // re-inserted last: each map's order is the order of the latest failure
      if (times.length >= max) {
        blockedKeys.set(key, times)
        const inWindow = (t: number[]) => t.filter(x => now - x < windowMs)
        dropOldest(
          blockedKeys,
          maxBlocked,
          t => inWindow(t).length < max,
          (dropped, t) => {
            const left = inWindow(t)
            if (left.length > 0 && left.length < max) counting.set(dropped, left)
          },
        )
      } else {
        counting.set(key, times)
        dropOldest(counting, maxKeys, t => t.every(x => now - x >= windowMs))
      }
    },
    /** Failures of a key inside the window (tests). */
    failed: (key: string, now = Date.now()) => recent(key, now).length,
    /** How many keys are kept (tests). */
    size: () => counting.size + blockedKeys.size,
    /** Forgets every key (tests). */
    clear: () => {
      counting.clear()
      blockedKeys.clear()
    },
  }
}

/**
 * A cooldown per key that grows with each hit (LIN-661): `leftMs` says from the key's recent hits how long the next one
 * waits. Hits older than `keepMs` are forgotten; at most `maxKeys` keys are kept (the one hit longest ago goes first).
 */
export function createCooldown({
  leftMs,
  keepMs,
  maxKeys = 50_000,
}: {
  leftMs: (hits: readonly number[], now: number) => number
  keepMs: number
  maxKeys?: number
}) {
  const hits = new Map<string, number[]>()
  const recent = (key: string, now: number) => (hits.get(key) ?? []).filter(t => now - t < keepMs)
  return {
    /** Milliseconds until the next hit is let through; 0 when it would be now. */
    left: (key: string, now = Date.now()) => leftMs(recent(key, now), now),
    /** Records a hit (whether or not it was waited for). */
    hit(key: string, now = Date.now()) {
      const times = [...recent(key, now), now].slice(-20)
      hits.delete(key) // re-inserted last: the map's order is the order of the latest hit
      hits.set(key, times)
      dropOldest(hits, maxKeys, t => t.every(x => now - x >= keepMs))
    },
    /** Forgets every key (tests). */
    clear: () => hits.clear(),
  }
}
