// The GitHub star prompt without React (server rules: apps/api/src/star-prompt.ts). It shows once a
// session, after the member has been idle for a moment in the inbox, and any answer is final.
// One click stars the repository for members who signed in with GitHub: GitHub asks them to allow
// starring (STAR_SCOPE), the server stars on the way back and gives the permission up again.
import type { StarPrompt } from '@linedesk/actions'

/** How long nothing happens (no key, click or scroll) before the card shows. */
export const STAR_IDLE_MS = 30_000

const SHOWN_KEY = 'linedesk.starPrompt.shown'
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
