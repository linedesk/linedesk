import { describe, expect, it } from 'vitest'
import { isModifierKey, isRedrawOf, parseShortcutTitle, scrollMoves } from './tooltips.ts'

/** Just enough of a DOM element for the tooltip rules: a tooltip text, whether it is on the page, its children. */
function fakeElement(tip: string | null, opts: { connected?: boolean; children?: object[]; doc?: object } = {}) {
  const children = opts.children ?? []
  return {
    isConnected: opts.connected ?? true,
    ownerDocument: opts.doc ?? null,
    getAttribute: (name: string) => (name === 'data-sc' ? tip : null),
    contains: (node: unknown) => node === undefined || children.includes(node as object),
  } as unknown as Element
}

describe('parseShortcutTitle', () => {
  it('splits the label from its keys', () => {
    expect(parseShortcutTitle('Mark done (E)')).toEqual({ label: 'Mark done', keys: ['E'] })
    expect(parseShortcutTitle('Assistant (G A)')).toEqual({ label: 'Assistant', keys: ['G', 'A'] })
  })
  it('keeps a plain title as the label', () => {
    expect(parseShortcutTitle('Only owners and admins can start a test call')).toEqual({
      label: 'Only owners and admins can start a test call',
      keys: [],
    })
  })
})

describe('scrollMoves', () => {
  const doc = {}
  const target = fakeElement('Why it is off', { doc })
  it('dismisses when the page scrolls', () => {
    expect(scrollMoves(doc as EventTarget, target)).toBe(true)
  })
  it('dismisses when an ancestor of the element scrolls', () => {
    const ancestor = fakeElement(null, { children: [target] })
    expect(scrollMoves(ancestor, target)).toBe(true)
  })
  it('stays up when an unrelated list or text field scrolls', () => {
    const elsewhere = fakeElement(null, { children: [] })
    expect(scrollMoves(elsewhere, target)).toBe(false)
  })
})

describe('isRedrawOf', () => {
  it('follows the element React put in place of the one under the pointer', () => {
    const old = fakeElement('Why it is off', { connected: false })
    expect(isRedrawOf(fakeElement('Why it is off'), old)).toBe(true)
  })
  it('is another tooltip when the text differs', () => {
    const old = fakeElement('Why it is off', { connected: false })
    expect(isRedrawOf(fakeElement('Start test call'), old)).toBe(false)
  })
  it('is a neighbour, not a redraw, while the old element is still on the page', () => {
    expect(isRedrawOf(fakeElement('Same text'), fakeElement('Same text'))).toBe(false)
  })
  it('needs both elements', () => {
    expect(isRedrawOf(null, fakeElement('x', { connected: false }))).toBe(false)
    expect(isRedrawOf(fakeElement('x'), null)).toBe(false)
  })
})

describe('isModifierKey', () => {
  it('lets a lone modifier leave the tooltip up, other keys dismiss it', () => {
    expect(isModifierKey('Meta')).toBe(true)
    expect(isModifierKey('Shift')).toBe(true)
    expect(isModifierKey('e')).toBe(false)
    expect(isModifierKey('Escape')).toBe(false)
  })
})
