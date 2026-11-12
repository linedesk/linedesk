// The GitHub star prompt without React (server rules: apps/api/src/star-prompt.ts). It shows once a
// session, two minutes after the session started, until the member answers; any answer is final.
// One click stars the repository for members who signed in with GitHub: GitHub asks them to allow
// starring (STAR_SCOPE), the server stars on the way back and gives the permission up again.
import type { StarPrompt } from '@linedesk/actions'

/** How long into a session the card shows. */
export const STAR_DELAY_MS = 120_000

/** From this many stars on the card names the count ("Join 1.2k others"); fewer would not convince anyone. */
export const STAR_COUNT_SHOWN_FROM = 100

/** The card's line: with the count once it is worth naming. */
export const starPitch = (product: string, stars: number | null, format: (n: number) => string) =>
  stars !== null && stars >= STAR_COUNT_SHOWN_FROM
    ? `${product} is open source. Join ${format(stars)} others who starred it on GitHub.`
    : `${product} is open source. A star on GitHub helps others find it.`

const SHOWN_KEY = 'linedesk.starPrompt.shown'
const STARTED_KEY = 'linedesk.starPrompt.sessionStart'
const RETURN_KEY = 'linedesk.starPrompt.granting'

/** What Star does for this member: the GitHub round trip that stars, or the repository page. */
export type StarMove = 'grant' | 'open'
export const starMove = (prompt: StarPrompt): StarMove => (prompt.github ? 'grant' : 'open')

export const repoUrl = (repo: string) => `https://github.com/${repo}`

function read(storage: Storage, key: string): string | null {
  try {
    return storage.getItem(key)
  } catch {
    return null
  }
}
function write(storage: Storage, key: string, value: string | null) {
  try {
    if (value === null) storage.removeItem(key)
    else storage.setItem(key, value)
  } catch {
    /* private window: the card may show once more */
  }
}

/**
 * Milliseconds until the card is due in this session: STAR_DELAY_MS after its first page load, so a reload
 * does not start the two minutes again. A new tab is a new session.
 */
export function msUntilDue(now = Date.now(), storage: Storage = sessionStorage): number {
  const stored = Number(read(storage, STARTED_KEY))
  const started = Number.isFinite(stored) && stored > 0 && stored <= now ? stored : now
  if (started === now) write(storage, STARTED_KEY, String(now))
  return Math.max(0, started + STAR_DELAY_MS - now)
}

/** Shown in this session already (unanswered): not again until the next one. */
export const shownThisSession = (storage: Storage = sessionStorage) => read(storage, SHOWN_KEY) === '1'
export const markShown = (storage: Storage = sessionStorage) => write(storage, SHOWN_KEY, '1')

/** Right before leaving for GitHub's consent page. */
export const markGranting = (storage: Storage = sessionStorage) => write(storage, RETURN_KEY, '1')

/**
 * On load: back from GitHub's consent page? `starred` when the prompt is gone (the server starred and
 * recorded it), `refused` while it is still due (no consent, or GitHub refused the star), null when this
 * load is not a return. Read once.
 */
export function takeGrantReturn(
  prompt: StarPrompt | null,
  storage: Storage = sessionStorage,
): 'starred' | 'refused' | null {
  if (read(storage, RETURN_KEY) !== '1') return null
  write(storage, RETURN_KEY, null)
  return prompt ? 'refused' : 'starred'
}
