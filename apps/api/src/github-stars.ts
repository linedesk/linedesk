// How many stars Linedesk's repository has on GitHub, for Star on GitHub in the app (GET /v1/branding).
// The server asks GitHub about once an hour and keeps the number in memory, so browsers never call GitHub
// (the Content-Security-Policy would not let them) and an install without internet simply shows no count.
// Nothing is sent but the request for the public repository; nothing is asked while the prompt is off.
import { STAR_REPO } from '@linedesk/actions'

const FRESH_MS = 60 * 60_000
/** After a failed request (offline, rate limit): try again sooner than an hour, but not on every check. */
const RETRY_MS = 10 * 60_000

let count: number | null = null
let nextTryAt = 0

/** The last star count read from GitHub, or null before the first successful read. */
export const starCount = () => count

/** GET /repos/{owner}/{repo}: its `stargazers_count`, or null when GitHub cannot be reached or answers oddly. */
export async function fetchStarCount(repo: string, fetchImpl: typeof fetch = fetch): Promise<number | null> {
  const res = await fetchImpl(`https://api.github.com/repos/${repo}`, {
    headers: { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'linedesk' },
    redirect: 'error',
    signal: AbortSignal.timeout(5_000),
  }).catch(() => null)
  if (!res?.ok) return null
  const body = (await res.json().catch(() => null)) as { stargazers_count?: unknown } | null
  const stars = body?.stargazers_count
  return typeof stars === 'number' && Number.isInteger(stars) && stars >= 0 ? stars : null
}

/** Reads the count again when it is due; a failure keeps the last count and tries again in a few minutes. */
export async function refreshStarCount(now = Date.now(), fetchImpl: typeof fetch = fetch): Promise<void> {
  if (now < nextTryAt) return
  nextTryAt = now + RETRY_MS // also guards against a second check while this one runs
  const stars = await fetchStarCount(STAR_REPO, fetchImpl)
  if (stars === null) return
  count = stars
  nextTryAt = now + FRESH_MS
}

/** For tests: forget the count and the schedule. */
export function resetStarCount() {
  count = null
  nextTryAt = 0
}
