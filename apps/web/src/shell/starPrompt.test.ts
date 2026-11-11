import { expect, test } from 'vitest'
import { markGranting, markShown, repoUrl, shownThisSession, starMove, takeGrantReturn } from './starPrompt.ts'

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
