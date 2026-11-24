import { describe, expect, it } from 'vitest'
import { inboxHints } from './hints.ts'

const keys = (hints: ReturnType<typeof inboxHints>) => hints.map(([k]) => k.join(' '))

describe('the inbox shortcut line', () => {
  it('names the row keys only while the view has calls', () => {
    expect(keys(inboxHints('you', true))).toEqual(['⏎', 'E', 'tab', '⌘ K', '?'])
    expect(keys(inboxHints('reminders', false))).toEqual(['tab', '⌘ K', '?'])
  })
  it('says ⇧E (not done) in Done', () => {
    expect(keys(inboxHints('done', true))).toEqual(['⏎', '⇧ E', 'tab', '⌘ K', '?'])
  })
})
