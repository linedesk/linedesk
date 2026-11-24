// The shared keys of every setup page (setup-keys.ts): one rule set for Enter and Esc.
import { expect, test } from 'vitest'
import { setupKeyFor } from './setup-keys.ts'

const key = (k: string, mods: Partial<KeyboardEvent> = {}) => ({
  key: k,
  shiftKey: false,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  isComposing: false,
  defaultPrevented: false,
  ...mods,
})
const el = (matches: string[], inForm = false) =>
  ({
    matches: (sel: string) => sel.split(',').some(s => matches.includes(s.trim())),
    closest: (sel: string) => (sel === 'form' && inForm ? {} : null),
  }) as unknown as Element
const noDialog = { querySelector: () => null }
const dialog = { querySelector: () => ({}) }

test('Enter runs the main action on the page and in a one-line field; never on a button, link or summary', () => {
  expect(setupKeyFor(key('Enter'), el([]), 'continue', noDialog)).toBe('enter')
  expect(setupKeyFor(key('Enter'), el(['input']), 'continue', noDialog)).toBe('enter')
  for (const tag of ['button', 'a', 'summary'])
    expect(setupKeyFor(key('Enter'), el([tag]), 'continue', noDialog)).toBe(null)
})

test('a text area takes Enter itself; ⌘/Ctrl+Enter runs the main action there', () => {
  expect(setupKeyFor(key('Enter'), el(['textarea']), 'continue', noDialog)).toBe(null)
  expect(setupKeyFor(key('Enter', { metaKey: true }), el(['textarea']), 'continue', noDialog)).toBe('enter')
  expect(setupKeyFor(key('Enter', { ctrlKey: true }), el([]), 'continue', noDialog)).toBe(null)
})

test('fields "ignore": nothing while a field has the focus', () => {
  expect(setupKeyFor(key('Enter'), el(['input']), 'ignore', noDialog)).toBe(null)
  expect(setupKeyFor(key('Escape'), el(['input']), 'ignore', noDialog)).toBe(null)
  expect(setupKeyFor(key('Enter'), el([]), 'ignore', noDialog)).toBe('enter')
})

test('Esc goes back; Shift+Esc stays the top bar’s; a modal dialog and a form take their own keys', () => {
  expect(setupKeyFor(key('Escape'), el([]), 'continue', noDialog)).toBe('escape')
  expect(setupKeyFor(key('Escape', { shiftKey: true }), el([]), 'continue', noDialog)).toBe(null)
  expect(setupKeyFor(key('Enter'), el([]), 'continue', dialog)).toBe(null)
  expect(setupKeyFor(key('Escape'), el([]), 'continue', dialog)).toBe(null)
  expect(setupKeyFor(key('Enter'), el(['input'], true), 'continue', noDialog)).toBe(null)
  expect(setupKeyFor(key('Enter', { isComposing: true }), el([]), 'continue', noDialog)).toBe(null)
})
