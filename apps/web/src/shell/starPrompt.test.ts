import { formatStarCount } from '@linedesk/actions'
import { expect, test } from 'vitest'
import {
  markGranting,
  markShown,
  msUntilDue,
  repoUrl,
  STAR_DELAY_MS,
  shownThisSession,
  starCardOnScreen,
  starMove,
  starPitch,
  takeGrantReturn,
} from './starPrompt.ts'

function memoryStorage(): Storage {
  const items = new Map<string, string>()
  return {
    get length() {
      return items.size
    },
    clear: () => items.clear(),
    getItem: k => items.get(k) ?? null,
    key: i => [...items.keys()][i] ?? null,
    removeItem: k => void items.delete(k),
    setItem: (k, v) => void items.set(k, v),
  }
}

const repo = 'linedesk/linedesk'

test('Star goes through GitHub for GitHub sign-ins, else opens the page', () => {
  expect(starMove({ repo, github: true })).toBe('grant')
  expect(starMove({ repo, github: false })).toBe('open')
  expect(repoUrl(repo)).toBe('https://github.com/linedesk/linedesk')
})

test('once a session', () => {
  const storage = memoryStorage()
  expect(shownThisSession(storage)).toBe(false)
  markShown(storage)
  expect(shownThisSession(storage)).toBe(true)
})

test('back from GitHub: starred when the prompt is gone, refused while it is still due, read once', () => {
  const storage = memoryStorage()
  expect(takeGrantReturn(null, storage)).toBeNull()
  markGranting(storage)
  expect(takeGrantReturn(null, storage)).toBe('starred')
  expect(takeGrantReturn(null, storage)).toBeNull()
  markGranting(storage)
  expect(takeGrantReturn({ repo, github: true }, storage)).toBe('refused')
})

test('the count reads short, and the card names it only once it convinces', () => {
  expect(formatStarCount(987)).toBe('987')
  expect(formatStarCount(1000)).toBe('1k')
  expect(formatStarCount(1234)).toBe('1.2k')
  expect(formatStarCount(56_789)).toBe('57k')
  expect(starPitch('Linedesk', 1234, formatStarCount)).toBe(
    'Linedesk is open source. Join 1.2k others who starred it on GitHub.',
  )
  expect(starPitch('Linedesk', 12, formatStarCount)).toBe(
    'Linedesk is open source. A star on GitHub helps others find it.',
  )
  expect(starPitch('Linedesk', null, formatStarCount)).toBe(
    'Linedesk is open source. A star on GitHub helps others find it.',
  )
})

test('due two minutes into the session, also after a reload', () => {
  const storage = memoryStorage()
  expect(msUntilDue(1_000_000, storage)).toBe(STAR_DELAY_MS)
  expect(msUntilDue(1_000_000 + 90_000, storage)).toBe(30_000)
  expect(msUntilDue(1_000_000 + 200_000, storage)).toBe(0)
})

test('the card shows only over the inbox: a page, a call, a dialog or the tour hides it until they close', () => {
  expect(starCardOnScreen('ask', false)).toBe(true)
  expect(starCardOnScreen('failed', false)).toBe(true)
  expect(starCardOnScreen('thanks', false)).toBe(true)
  // Shown on the inbox, then a settings page opened: it steps aside, unanswered, and is back on the inbox.
  expect(starCardOnScreen('ask', true)).toBe(false)
  expect(starCardOnScreen('failed', true)).toBe(false)
  expect(starCardOnScreen('thanks', true)).toBe(false)
  expect(starCardOnScreen('waiting', false)).toBe(false)
  expect(starCardOnScreen('closed', false)).toBe(false)
})
