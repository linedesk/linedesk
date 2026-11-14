import { describe, expect, it } from 'vitest'
import { chordTarget } from './chords.ts'

const all = { instanceAdmin: true, review: true, assign: true }
const member = { instanceAdmin: false, review: false, assign: false }

describe('G chords', () => {
  it('G S opens Workspace settings at General, G T its Team section', () => {
    expect(chordTarget('s', member)).toEqual({ kind: 'page', route: 'workspace' })
    expect(chordTarget('t', member)).toEqual({ kind: 'page', route: 'workspace', section: 'team' })
  })

  it('keeps the other pages and views', () => {
    expect(chordTarget('a', member)).toEqual({ kind: 'page', route: 'assistant' })
    expect(chordTarget('c', member)).toEqual({ kind: 'page', route: 'contacts' })
    expect(chordTarget('n', member)).toEqual({ kind: 'page', route: 'insights' })
    expect(chordTarget('i', member)).toEqual({ kind: 'tab', tab: 'you' })
    expect(chordTarget('e', member)).toEqual({ kind: 'tab', tab: 'done' })
    expect(chordTarget('h', member)).toEqual({ kind: 'tab', tab: 'reminders' })
  })

  it('offers Admin, How <assistant> did and the assignee views only to who can use them', () => {
    expect(chordTarget('d', all)).toEqual({ kind: 'page', route: 'admin' })
    expect(chordTarget('d', member)).toBeNull()
    // G R: the assistant review in the Assistant area, no longer an inbox view.
    expect(chordTarget('r', all)).toEqual({ kind: 'page', route: 'assistant', section: 'review' })
    expect(chordTarget('r', member)).toBeNull()
    expect(chordTarget('m', all)).toEqual({ kind: 'tab', tab: 'mine' })
    expect(chordTarget('u', all)).toEqual({ kind: 'tab', tab: 'unassigned' })
    expect(chordTarget('m', member)).toBeNull()
    expect(chordTarget('u', member)).toBeNull()
  })

  it('does nothing for other keys and inherited names', () => {
    for (const key of ['x', 'z', 'constructor', 'toString', '']) expect(chordTarget(key, all)).toBeNull()
  })
})
