import { describe, expect, it } from 'vitest'
import { commandScore, rank } from './CommandMenu.tsx'
import { uniqueKeys } from './uniqueKeys.ts'

describe('command matching', () => {
  it('scores prefix over word starts over initials over substring', () => {
    expect(commandScore('Mark done', 'mark')).toBe(4)
    expect(commandScore('Go to Assistant', 'assi')).toBe(3)
    expect(commandScore('Show keyboard shortcuts', 'sks')).toBe(2)
    expect(commandScore('Mark unread', 'read')).toBe(1)
    expect(commandScore('Mark done', 'xyz')).toBe(0)
    expect(commandScore('Mark done', '  ')).toBe(1)
  })
  const groups = [
    { label: 'Call', items: [{ label: 'Mark done' }, { label: 'Mark unread' }, { label: 'Remind me' }] },
    { label: 'App', items: [{ label: 'Undo' }, { label: 'Mark done' }] },
    { label: 'Empty', items: [] },
  ]
  it('keeps the groups without a query and drops empty ones', () => {
    expect(rank(groups, '').map(g => g.label)).toEqual(['Call', 'App'])
  })
  it('returns one ranked list without duplicates for a query', () => {
    expect(rank(groups, 'un')).toEqual([{ label: null, items: [{ label: 'Undo' }, { label: 'Mark unread' }] }])
    expect(rank(groups, 'mark')[0]!.items.map(i => i.label)).toEqual(['Mark done', 'Mark unread'])
    expect(rank(groups, 'nothing')).toEqual([])
  })
})

describe('command keywords', () => {
  it('finds an item by its other words, ranked below a label match', () => {
    const groups = [{ label: null, items: [{ label: 'Mark read', keywords: 'read unread' }, { label: 'Undo' }] }]
    expect(rank(groups, 'unread')[0]!.items.map(i => i.label)).toEqual(['Mark read'])
    expect(rank(groups, 'un')[0]!.items.map(i => i.label)).toEqual(['Undo', 'Mark read'])
  })
})

describe('uniqueKeys', () => {
  it('numbers repeated texts so React keys stay unique', () => {
    expect(uniqueKeys(['Call back', 'Send quote', 'Call back', 'Call back'])).toEqual(['Call back', 'Send quote', 'Call back#2', 'Call back#3'])
  })
})
